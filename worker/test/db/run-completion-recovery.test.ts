import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { PgRealtimeTransport, QueueRetryAfterError } from '@nessie/runtime'
import {
  RunCompletionFollowupJobPayloadSchema,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { completeRunExecution } from '../../src/run/execute/completion.js'
import { commitSuccessfulRun } from '../../src/run/execute/completion-commit.js'
import { executeRunCompletionFollowup } from '../../src/run/execute/completion-followup.js'
import {
  claimRunForExecution,
  withRunExecutorFence,
} from '../../src/run/execute/lifecycle.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('completion commit survives a follow-up fault and replays without duplication', async () => {
  const connectionString = process.env['DATABASE_URL']!
  const prisma = new PrismaClient()
  const pool = new Pool({ connectionString, max: 5 })
  const realtimeChannel = `completion_recovery_${randomUUID().replaceAll('-', '')}`
  const realtime = new PgRealtimeTransport(pool, connectionString, realtimeChannel)
  const ids = {
    user: randomUUID(),
    message: randomUUID(),
  }
  const organization = await prisma.organization.create({
    data: { name: `completion recovery ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      organizationId: organization.id,
      projectId: project.id,
      slug: `completion-recovery-${randomUUID()}`,
      teamId: team.id,
    },
  })
  const mentionedUser = await prisma.user.create({
    data: {
      displayName: 'Mentioned One',
      email: `completion-mentioned-${randomUUID()}@example.test`,
    },
  })
  await prisma.channelMember.create({
    data: { channelId: channel.id, userId: mentionedUser.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { name: 'Completer', organizationId: organization.id, status: 'executing' },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'pending', threadId: thread.id },
  })
  const task = await prisma.task.create({
    data: { agentId: agent.id, organizationId: organization.id, runId: run.id },
  })
  const plan = await prisma.plan.create({
    data: {
      agentId: agent.id,
      channelId: channel.id,
      createdByActorId: ids.user,
      createdByActorType: 'user',
      goal: 'answer once',
      organizationId: organization.id,
      runId: run.id,
      status: 'active',
    },
  })
  const rootStep = await prisma.planStep.create({
    data: {
      planId: plan.id,
      sequence: 0,
      status: 'running',
      title: 'answer once',
      type: 'message',
    },
  })
  const workflowTemplate = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: ids.user,
      createdByActorType: 'user',
      graphJson: {
        steps: [
          { id: 'agent-step', type: 'agent' },
          { id: 'next-step', type: 'tool' },
        ],
      },
      name: 'completion recovery workflow',
      organizationId: organization.id,
    },
  })
  const workflowInstallation = await prisma.workflowInstallation.create({
    data: {
      createdByActorId: ids.user,
      createdByActorType: 'user',
      organizationId: organization.id,
      workflowTemplateId: workflowTemplate.id,
      workflowTemplateVersion: 1,
    },
  })
  const workflowRun = await prisma.workflowRun.create({
    data: {
      installationId: workflowInstallation.id,
      organizationId: organization.id,
      startedAt: new Date(),
      startedByActorId: ids.user,
      startedByActorType: 'user',
      status: 'running',
    },
  })
  const workflowStep = await prisma.workflowStepRun.create({
    data: {
      sequence: 0,
      status: 'running',
      stepKey: 'agent-step',
      stepType: 'agent',
      title: 'Agent step',
      workflowRunId: workflowRun.id,
    },
  })
  await prisma.workflowStepRun.create({
    data: {
      sequence: 1,
      status: 'blocked',
      stepKey: 'next-step',
      stepType: 'tool',
      title: 'Next step',
      workflowRunId: workflowRun.id,
    },
  })
  const payload = {
    actorContext: {
      actor: { actorId: ids.user, actorType: 'user' },
      actionContext: {
        channelId: channel.id,
        projectId: project.id,
        requestId: `completion-recovery-${randomUUID()}`,
        taskId: task.id,
        teamId: team.id,
        threadId: thread.id,
      },
      tenant: { organizationId: organization.id, teamId: team.id },
    },
    agentId: agent.id,
    interactive: true,
    messageId: ids.message,
    parentWorkflowRunId: workflowRun.id,
    parentWorkflowStepRunId: workflowStep.id,
    runId: run.id,
    taskId: task.id,
    threadId: thread.id,
  } as RunExecuteJobPayload
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: agent.id,
      model: null,
      name: agent.name,
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      id: channel.id,
      organizationId: organization.id,
      projectId: project.id,
      systemChannelType: null,
      teamId: team.id,
      visibility: channel.visibility,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: run.createdAt, id: run.id, replyPlacement: null, threadId: thread.id },
    task: { id: task.id },
  } satisfies RunContext
  const baseDeps = {
    prisma,
    realtimeTransport: realtime,
    searchConfig: { pool },
  } as unknown as ExecutionDependencies
  let terminalTransactionCalls = 0
  let releaseCommit: () => void = () => undefined
  let markWritesFinished: () => void = () => undefined
  let ambiguousReadbackStarted = false
  let topLevelDecisionReads = 0
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
  const writesFinished = new Promise<void>((resolve) => { markWritesFinished = resolve })
  const commitAckLostPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async (...args: unknown[]) => {
          terminalTransactionCalls += 1
          if (terminalTransactionCalls > 1) {
            return (target.$transaction as unknown as (
              ...callArgs: unknown[]
            ) => Promise<unknown>)(...args)
          }
          const callback = args[0] as (tx: unknown) => Promise<unknown>
          const unsettledCommit = (target.$transaction as unknown as (
            ...callArgs: unknown[]
          ) => Promise<unknown>)(async (tx: unknown) => {
            const result = await callback(tx)
            markWritesFinished()
            await commitGate
            return result
          }, ...args.slice(1))
          await writesFinished
          // Verification starts while this transaction still holds the run-row
          // lock. Releasing on the next timer turn makes its FOR UPDATE the
          // deterministic settlement barrier before it can inspect follow-up.
          setTimeout(releaseCommit, 25)
          void unsettledCommit.catch(() => undefined)
          ambiguousReadbackStarted = true
          throw new Error('injected lost COMMIT acknowledgement')
        }
      }
      if (ambiguousReadbackStarted && (property === 'run' || property === 'queueJob')) {
        topLevelDecisionReads += 1
      }
      return Reflect.get(target, property, target)
    },
  })

  try {
    await withRunExecutorFence(run.id, async () => {
      assert.equal((await claimRunForExecution(prisma, run.id)).claimed, true)
      await completeRunExecution(
        { ...baseDeps, prisma: commitAckLostPrisma } as ExecutionDependencies,
        payload,
        context,
        {
          planId: plan.id,
          rootStepId: rootStep.id,
        },
        {
          invocations: [],
          iterations: 2,
          memories: [],
          responseText: '@Mentioned One, one durable answer.',
          toolCallsUsed: 1,
        },
      )
    })

    const committed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } })
    assert.equal(committed.status, 'completed')
    assert.equal(
      terminalTransactionCalls,
      2,
      'the lost acknowledgement is resolved through one verification transaction',
    )
    assert.equal(
      topLevelDecisionReads,
      0,
      'run and follow-up are not read independently across snapshots',
    )
    assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).status, 'idle')
    assert.equal(await prisma.message.count({ where: { threadId: thread.id } }), 1)
    assert.equal(
      await prisma.taskEvent.count({ where: { eventType: 'run.failed', taskId: task.id } }),
      0,
      'a lost COMMIT acknowledgement does not enter the generic failure path',
    )
    const followupRow = await prisma.queueJob.findUniqueOrThrow({
      where: { idempotencyKey: `run-completion-followup:${run.id}` },
    })
    const followup = RunCompletionFollowupJobPayloadSchema.parse(followupRow.payload)

    let memoryFailureInjected = false
    const transientMemoryPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$executeRaw') {
          return async (query: { values?: unknown[] }, ...values: unknown[]) => {
            if (
              !memoryFailureInjected
              && Array.isArray(query.values)
              && query.values.includes(`memory-run-consolidate:${run.id}`)
            ) {
              memoryFailureInjected = true
              throw new Error('injected memory enqueue failure')
            }
            return (target.$executeRaw as unknown as (
              query: unknown,
              ...rawValues: unknown[]
            ) => Promise<number>).apply(target, [query, ...values])
          }
        }
        return Reflect.get(target, property, target)
      },
    })
    await assert.rejects(
      executeRunCompletionFollowup(
        { ...baseDeps, prisma: transientMemoryPrisma } as ExecutionDependencies,
        followup,
      ),
      /injected memory enqueue failure/,
    )

    let injected = false
    const faultingRealtime = {
      publishSse: realtime.publishSse.bind(realtime),
      publishWs: async (...args: Parameters<PgRealtimeTransport['publishWs']>) => {
        if (!injected && args[1].event === 'run.updated') {
          injected = true
          throw new Error('injected post-answer publish fault')
        }
        return realtime.publishWs(...args)
      },
    }
    await assert.rejects(
      executeRunCompletionFollowup(
        { ...baseDeps, realtimeTransport: faultingRealtime } as ExecutionDependencies,
        followup,
      ),
      /injected post-answer publish fault/,
    )

    // A new run may start before redelivery. The follow-up must not write idle
    // again over this newer ownership state.
    await prisma.run.create({
      data: { agentId: agent.id, status: 'running', threadId: thread.id },
    })
    await prisma.agent.update({ data: { status: 'executing' }, where: { id: agent.id } })
    await executeRunCompletionFollowup(baseDeps, followup)
    await executeRunCompletionFollowup(baseDeps, followup)

    assert.equal(await prisma.message.count({ where: { threadId: thread.id } }), 1)
    assert.equal((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status, 'completed')
    assert.equal(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).status,
      'executing',
    )
    assert.equal((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).status, 'completed')
    assert.equal(
      (await prisma.planStep.findUniqueOrThrow({ where: { id: rootStep.id } })).status,
      'completed',
    )
    assert.equal(
      (await prisma.workflowStepRun.findUniqueOrThrow({ where: { id: workflowStep.id } })).status,
      'completed',
    )
    assert.equal(
      (await prisma.workflowRun.findUniqueOrThrow({ where: { id: workflowRun.id } })).status,
      'running',
    )
    assert.equal(
      await prisma.queueJob.count({
        where: {
          idempotencyKey: `workflow-run:continue:${workflowRun.id}:${workflowStep.id}`,
        },
      }),
      1,
      'replay after the later realtime fault does not duplicate the continuation',
    )
    const eventRows = await prisma.realtimeEvent.findMany({
      where: { idempotencyKey: { startsWith: `run-completion:${organization.id}:` } },
    })
    const streamRows = await prisma.threadStreamEvent.findMany({
      where: { idempotencyKey: { startsWith: `run-completion:${organization.id}:` } },
    })
    assert.equal(eventRows.filter((event) => event.eventType === 'message.new').length, 1)
    assert.equal(eventRows.filter((event) => event.eventType === 'run.updated').length, 1)
    assert.equal(streamRows.filter((event) => event.eventName === 'stream.done').length, 1)
    assert.equal(
      await prisma.userAlert.count({
        where: { messageId: followup.delivery.kind === 'message' ? followup.delivery.messageId : '' },
      }),
      1,
      'mention persistence is replay-idempotent',
    )
    assert.equal(eventRows.filter((event) => event.eventType === 'alert.created').length, 1)
    assert.equal(
      await prisma.queueJob.count({
        where: { idempotencyKey: `memory-run-consolidate:${run.id}` },
      }),
      1,
    )
    assert.equal(
      await prisma.queueJob.count({ where: { idempotencyKey: `push:reply:${run.id}` } }),
      1,
      'a redelivery after all follow-ups completed does not duplicate the reply push',
    )

    const uncertainRun = await prisma.run.create({
      data: { agentId: agent.id, status: 'pending', threadId: thread.id },
    })
    const uncertainTask = await prisma.task.create({
      data: {
        agentId: agent.id,
        organizationId: organization.id,
        runId: uncertainRun.id,
      },
    })
    const unavailableReadPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async () => { throw new Error('injected uncertain transaction') }
        }
        if (property === 'run') {
          return {
            findUnique: async () => { throw new Error('injected readback outage') },
          }
        }
        return Reflect.get(target, property, target)
      },
    })
    await withRunExecutorFence(uncertainRun.id, async () => {
      assert.equal((await claimRunForExecution(prisma, uncertainRun.id)).claimed, true)
      await assert.rejects(
        commitSuccessfulRun(
          unavailableReadPrisma,
          {
            agentId: agent.id,
            completedAt: new Date(),
            runId: uncertainRun.id,
            taskId: uncertainTask.id,
          },
          async () => undefined,
        ),
        (error: unknown) => {
          assert.ok(error instanceof QueueRetryAfterError)
          assert.ok(error.delayMs > 0)
          return true
        },
      )
    })
    assert.equal(
      (await prisma.run.findUniqueOrThrow({ where: { id: uncertainRun.id } })).status,
      'running',
      'an unavailable commit readback leaves the run retryable',
    )
    assert.equal(await prisma.message.count({ where: { threadId: thread.id } }), 1)
  } finally {
    await realtime.close()
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.delete({ where: { id: mentionedUser.id } })
    await pool.end()
    await prisma.$disconnect()
  }
})
