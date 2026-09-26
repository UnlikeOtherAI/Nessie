import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, parseOrganizationId, parseUserId } from '@nessie/schemas'

import { createExecutorMcpSessionManager } from '../../../executor/src/mcp-session-manager.js'
import { runReplyBasis } from '../../src/run/execute/agent-message.js'
import {
  admitRunCheckpoint,
  loadRunCheckpointForRun,
  persistRunCheckpoint,
} from '../../src/run/execute/checkpoint.js'
import { createConsumedSourceSink, type ConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { launchConversationScope } from '../../src/run/executor-host-output.js'
import { buildExecutorToolset } from '../../src/run/executor-toolset.js'
import { runTicketCreateTool } from '../../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import {
  deleteLocalAppsLane,
  LANE_SECRET,
  launchLocalApps,
  localAppsToolPolicy,
  SCRIPTED_MCP_SERVER,
  seedLocalAppsExecutor,
  startStandInDaemon,
} from './executor-lane-fixture.js'
import { runDatabaseTest } from './support.js'

/**
 * Host program output survives "keep going" with its stamp.
 *
 * A run that hits a budget ceiling writes a checkpoint whose note may quote
 * the program's output verbatim, and it persists the note under its reply
 * basis — which subtracts the run's own channel, the very scope the output
 * was stamped with. The continuation is a new run with no executor bindings,
 * so nothing re-stamped it: it could post the output to another channel or
 * another project's board. This drives the real lane for the first run, the
 * real checkpoint writer and loader, and the real admission a resuming run
 * performs, then asks the destination rules what the continuation may do —
 * and asks again one continuation further down the chain.
 */

type Room = { id: string; projectId: string; teamId: string }

const REFUSED = /I cannot copy restricted research into this shared project/

runDatabaseTest('a checkpoint continuation of a local-apps run keeps the launch stamp', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const organizationId = randomUUID()
  const ownerId = randomUUID()
  const agentId = randomUUID()
  const executorId = randomUUID()
  const runIds: string[] = []
  const sessions = createExecutorMcpSessionManager([{
    command: [process.execPath, SCRIPTED_MCP_SERVER],
    env: { NESSIE_TEST_MCP_MODE: 'ok' },
    name: 'kelpie',
  }], { maxResultBytes: 65_536 }, { log: () => undefined, startTimeoutMs: 15_000 })
  let daemon: ReturnType<typeof startStandInDaemon> | undefined
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: ownerId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  try {
    await prisma.organization.create({ data: { id: organizationId, name: `host-output-checkpoint-${suffix}` } })
    await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@example.test`, displayName: 'Machine owner' } })
    await prisma.organizationMember.create({ data: { organizationId, role: 'owner', userId: ownerId } })
    const toolPolicy = await localAppsToolPolicy(prisma, organizationId)
    await prisma.agent.create({ data: { id: agentId, name: 'CTO', organizationId, toolPolicy } })
    await seedLocalAppsExecutor(prisma, actor, {
      agentId, executorId, mcpServers: ['kelpie'], organizationId, userId: ownerId,
    })

    const homeFor = async (name: string) => {
      const project = await prisma.project.create({ data: { name: `${name}-${suffix}`, organizationId } })
      const team = await prisma.team.create({ data: { name: `${name}-team-${suffix}`, projectId: project.id } })
      return { projectId: project.id, teamId: team.id }
    }
    const roomIn = async (home: { projectId: string; teamId: string }, label: string): Promise<Room> => {
      const channel = await prisma.channel.create({ data: {
        label: `${label}-${suffix}`, organizationId, projectId: home.projectId, slug: `${label}-${suffix}`,
        teamId: home.teamId, type: 'standard', visibility: 'public',
      } })
      await prisma.channelMember.create({ data: { channelId: channel.id, userId: ownerId } })
      await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
      return { id: channel.id, projectId: home.projectId, teamId: home.teamId }
    }
    const product = await homeFor('product')
    const elsewhere = await homeFor('elsewhere')
    const launchRoom = await roomIn(product, 'engineering')
    const otherRoom = await roomIn(product, 'marketing')
    const thread = await prisma.thread.create({ data: { channelId: launchRoom.id } })
    daemon = startStandInDaemon(prisma, { executorId, sessions })

    const newRun = async () => {
      const trigger = await prisma.message.create({ data: {
        content: 'Keep going', role: 'user', threadId: thread.id, userId: ownerId,
      } })
      const run = await prisma.run.create({ data: {
        agentId, status: 'running', threadId: thread.id, triggerMessageId: trigger.id,
      } })
      runIds.push(run.id)
      const task = await prisma.task.create({ data: { agentId, organizationId, runId: run.id } })
      return { runId: run.id, taskId: task.id }
    }
    // The shape of a run's context the reply-basis rule reads.
    const contextIn = (room: Room, sink: ConsumedSourceSink) => ({
      boundAgentIds: [agentId],
      channel: { id: room.id, organizationId, projectId: room.projectId, teamId: room.teamId },
      consumedSources: sink,
      emailMailboxId: null,
    }) as unknown as RunContext
    const checkpointRun = async (
      run: { runId: string; taskId: string },
      sink: ConsumedSourceSink,
      generation: number,
    ) => {
      const basis = runReplyBasis(contextIn(launchRoom, sink))
      assert.deepEqual(basis, [], 'the reply basis subtracts the launch room, so it cannot carry the stamp')
      await persistRunCheckpoint(prisma, {
        agentId, basis, disclosureSources: [], generation, note: 'Kelpie said: HOST-OUTPUT-CANARY',
        organizationId, reason: 'token_limit', rootMessageId: null, runId: run.runId, sources: [],
        taskId: run.taskId, threadId: thread.id,
      })
    }
    // The owner's "Keep going" in the conversation the notes came from.
    const ownersReply = (runId: string, threadId: string) => ({
      agentId,
      principalUserId: null,
      resumer: { kind: 'user' as const, scopes: [], userId: ownerId },
      rootMessageId: null,
      runId,
      threadId,
    })
    const resume = async () => {
      const run = await newRun()
      const loaded = await loadRunCheckpointForRun(prisma, ownersReply(run.runId, thread.id))
      assert.ok(loaded, 'the continuation claims the checkpoint')
      const sink = createConsumedSourceSink()
      await admitRunCheckpoint(prisma, sink, loaded)
      return { loaded, run, sink }
    }
    const toolContext = (sink: ConsumedSourceSink): BuiltinToolRuntimeContext => ({
      actorContext: {
        actionContext: { effectiveUserId: parseUserId(ownerId), requestId: randomUUID() },
        actor: { actorId: parseUserId(ownerId), actorType: 'user', roles: ['owner'] },
        tenant: { organizationId: parseOrganizationId(organizationId) },
      },
      agentId,
      // An organisation owner's assistant may reach any project, so it is the
      // disclosure gate, not the project guard, that answers below.
      agentKind: 'personal_assistant',
      channel: {
        id: launchRoom.id, organizationId: parseOrganizationId(organizationId), projectId: launchRoom.projectId,
        systemChannelType: null, teamId: launchRoom.teamId,
      },
      consumedSources: sink,
      ledgerIdentity: null,
      prisma,
      realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
      run: { id: randomUUID(), messageId: randomUUID(), threadId: thread.id },
      toolCallId: randomUUID(),
    })

    // The first run: a person launched local apps here, the agent read a
    // program answer, then the run hit its budget.
    const first = await newRun()
    await launchLocalApps(prisma, actor, { agentId, executorId, runId: first.runId, userId: ownerId })
    const firstSink = createConsumedSourceSink()
    const toolset = await buildExecutorToolset(prisma, {
      agentId, agentToolPolicy: toolPolicy, encryptionSecret: LANE_SECRET,
      hostOutput: { launchScope: launchConversationScope(launchRoom.id), sink: firstSink },
      organizationId, runId: first.runId,
    })
    const answer = await createExecutorToolExecution(
      { prisma } as unknown as ExecutionDependencies,
      { run: { id: first.runId } } as unknown as RunContext,
      toolset,
    )('executor_mcp_call', { arguments: { value: 'HOST-OUTPUT-CANARY' }, server: 'kelpie', tool: 'echo' }, `provider-${first.runId}`, actor)
    assert.equal(answer.success, true)
    await checkpointRun(first, firstSink, 1)

    // "Keep going": the continuation holds the stamp the note needs.
    const second = await resume()
    assert.deepEqual(second.loaded.basisScopes, [])
    assert.deepEqual(second.loaded.hostOutputScopes, [launchConversationScope(launchRoom.id)])
    assert.deepEqual(second.sink.hostOutputScopes(), [launchConversationScope(launchRoom.id)])

    // A reply in the launch conversation is unaffected; the same text in
    // another room of the same project is restricted to the launch room.
    assert.deepEqual(runReplyBasis(contextIn(launchRoom, second.sink)), [])
    assert.deepEqual(runReplyBasis(contextIn(otherRoom, second.sink)), [launchConversationScope(launchRoom.id)])
    // Another project's board is refused; the launch project's board, from
    // its public room, is not.
    await assert.rejects(
      runTicketCreateTool(toolContext(second.sink), { projectId: elsewhere.projectId, title: 'HOST-OUTPUT-CANARY elsewhere' }),
      REFUSED,
    )
    await runTicketCreateTool(toolContext(second.sink), { projectId: product.projectId, title: 'HOST-OUTPUT-CANARY here' })
    assert.equal(await prisma.task.count({ where: { organizationId, title: 'HOST-OUTPUT-CANARY here' } }), 1)
    assert.equal(await prisma.task.count({ where: { organizationId, title: 'HOST-OUTPUT-CANARY elsewhere' } }), 0)

    // The continuation never called the program itself, and hits its budget
    // too: a second "keep going" still carries the stamp down the chain.
    await checkpointRun(second.run, second.sink, 2)
    const third = await resume()
    assert.deepEqual(third.loaded.hostOutputScopes, [launchConversationScope(launchRoom.id)])
    assert.deepEqual(runReplyBasis(contextIn(otherRoom, third.sink)), [launchConversationScope(launchRoom.id)])
    await assert.rejects(
      runTicketCreateTool(toolContext(third.sink), { projectId: elsewhere.projectId, title: 'Still elsewhere' }),
      REFUSED,
    )

    // A checkpoint chain that never reached a program carries no stamp.
    const quietThread = await prisma.thread.create({ data: { channelId: launchRoom.id } })
    const quiet = await prisma.run.create({ data: { agentId, status: 'running', threadId: quietThread.id } })
    runIds.push(quiet.id)
    const quietTask = await prisma.task.create({ data: { agentId, organizationId, runId: quiet.id } })
    await prisma.toolCall.create({ data: {
      agentId, inputSummary: 'q=release notes', runId: quiet.id, startedAt: new Date(), toolName: 'kb_search',
    } })
    await persistRunCheckpoint(prisma, {
      agentId, basis: [], disclosureSources: [], generation: 1, note: 'Nothing from a machine.',
      organizationId, reason: 'token_limit', rootMessageId: null, runId: quiet.id, sources: [],
      taskId: quietTask.id, threadId: quietThread.id,
    })
    const quietNext = await prisma.run.create({ data: { agentId, status: 'running', threadId: quietThread.id } })
    runIds.push(quietNext.id)
    const quietLoaded = await loadRunCheckpointForRun(prisma, ownersReply(quietNext.id, quietThread.id))
    assert.deepEqual(quietLoaded?.hostOutputScopes, [])
    await daemon.stop()
  } finally {
    await daemon?.stop().catch(() => undefined)
    await sessions.stopAll()
    try {
      await deleteLocalAppsLane(prisma, { executorId, organizationId, runIds })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: ownerId } })
    } finally {
      await prisma.$disconnect()
    }
  }
})
