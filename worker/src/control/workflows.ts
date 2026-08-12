import { Prisma, type PrismaClient } from '@prisma/client'
import {
  collectWorkflowTaintedRefs,
  parseWorkflowBindingTemplate,
  redactWorkflowSecretValues,
  type WorkflowBindingScope,
} from '@nessie/workspace-admin'
import type { LedgerIdentityService } from '@nessie/runtime'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { randomUUID } from 'node:crypto'
import { enqueueQueueJob } from '../queue.js'
import {
  WORKFLOW_STEP_LEASE_HEARTBEAT_MS,
  ensureWorkflowStepRuns,
  heartbeatWorkflowStepLease,
  listWorkflowStepRuns,
  loadWorkflowGraph,
  markWorkflowRunFinished as markWorkflowRunFinishedRaw,
  markWorkflowRunStarted,
  markWorkflowStepRunFinished as markWorkflowStepRunFinishedRaw,
  markWorkflowStepRunQueued,
  markWorkflowStepRunStarted,
  reconcileWorkflowRunGraphSnapshot,
} from '../run/workflows.js'
import {
  executeWorkflowBuiltinTool,
  type WorkflowBuiltinToolRuntimeContext,
} from '../run/tools.js'
import {
  buildWorkflowRunEventContext,
  emitWorkflowRunTerminalEvent,
} from './workflow-run-events.js'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const resolveBoundValue = (bindings: unknown, key: unknown): unknown => {
  if (typeof key !== 'string' || key.length === 0) {
    return undefined
  }
  const record = asObject(bindings)
  return record[key]
}

type WorkflowStepSnapshot = {
  input: unknown
  output: unknown
  status: string
}

type WorkflowBindingContext = {
  /** W0: refs the workflow's own bindings marked secret. Never leave a sink. */
  taintedRefs?: ReadonlySet<string>
  workflowBindings: unknown
  workflowConfig: unknown
  workflowInput: unknown
  stepSnapshots: Record<string, WorkflowStepSnapshot>
}

export const buildWorkflowBindingContext = (input: {
  stepSnapshots: Record<string, WorkflowStepSnapshot>
  workflowBindings: unknown
  workflowConfig: unknown
  workflowInput: unknown
}): WorkflowBindingContext => ({
  ...input,
  taintedRefs: collectWorkflowTaintedRefs(input.workflowBindings),
})

const getPathValue = (value: unknown, path: string[]): unknown => {
  let current: unknown = value
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }

    if (typeof current !== 'object') {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

const resolveWorkflowBindingScope = (
  reference: WorkflowBindingScope,
  context: WorkflowBindingContext & { taintedRefs: ReadonlySet<string> },
): unknown => {
  if (reference.kind === 'workflow') {
    const source =
      reference.scope === 'config'
        ? context.workflowConfig
        : reference.scope === 'bindings'
          ? context.workflowBindings
          : context.workflowInput
    // W0 sink 2/3: a tainted ref reached through workflow.* never reaches the
    // rendered message body or the transform context.
    return redactWorkflowSecretValues(getPathValue(source, reference.path), context.taintedRefs)
  }

  const stepSnapshot = context.stepSnapshots[reference.stepId]
  if (!stepSnapshot) {
    return undefined
  }
  if (reference.scope === 'input') {
    return redactWorkflowSecretValues(
      getPathValue(stepSnapshot.input, reference.path),
      context.taintedRefs,
    )
  }
  if (reference.scope === 'output') {
    return redactWorkflowSecretValues(
      getPathValue(stepSnapshot.output, reference.path),
      context.taintedRefs,
    )
  }
  return stepSnapshot.status
}



const stringifyWorkflowBindingValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

const stripWorkflowDesignerConfig = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'workflowDesigner'),
  )

const formatBindingExpression = (segments: string[]): string => segments.join('.')

const resolveWorkflowTemplateString = (
  value: string,
  context: WorkflowBindingContext & { taintedRefs: ReadonlySet<string> },
): unknown => {
  // Same grammar as save-time validation (W9): invalid syntax here means the
  // template was authored before the validator existed or bypassed it.
  const template = parseWorkflowBindingTemplate(value)
  if (template.kind === 'literal') {
    return value
  }
  if (template.kind === 'invalid') {
    throw new Error(`WORKFLOW_BINDING_INVALID:${template.error}`)
  }

  if (template.kind === 'exact') {
    const resolved = resolveWorkflowBindingScope(template.token.reference, context)
    if (resolved === undefined) {
      throw new Error(
        `WORKFLOW_BINDING_NOT_FOUND:${formatBindingExpression(template.token.segments)}`,
      )
    }
    return resolved
  }

  let resolved_value = value
  for (const token of template.tokens) {
    const resolved = resolveWorkflowBindingScope(token.reference, context)
    if (resolved === undefined) {
      throw new Error(
        `WORKFLOW_BINDING_NOT_FOUND:${formatBindingExpression(token.segments)}`,
      )
    }
    resolved_value = resolved_value.replace(token.raw, stringifyWorkflowBindingValue(resolved))
  }
  return resolved_value
}

export const resolveWorkflowStepInput = (
  value: unknown,
  context: WorkflowBindingContext,
): unknown => {
  // Taint is derived lazily so unit callers can pass the pre-W0 context shape;
  // production builds the context through buildWorkflowBindingContext, which
  // always supplies the set.
  const taintedRefs =
    context.taintedRefs ?? collectWorkflowTaintedRefs(context.workflowBindings)
  const derived = { ...context, taintedRefs }
  return resolveWorkflowStepInputInner(value, derived)
}

const resolveWorkflowStepInputInner = (
  value: unknown,
  context: WorkflowBindingContext & { taintedRefs: ReadonlySet<string> },
): unknown => {
  if (typeof value === 'string') {
    return resolveWorkflowTemplateString(value, context)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveWorkflowStepInputInner(entry, context))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveWorkflowStepInputInner(entry, context),
      ]),
    )
  }
  return value
}

const buildWorkflowStepSnapshots = (
  stepRuns: Awaited<ReturnType<typeof listWorkflowStepRuns>>,
): Record<string, WorkflowStepSnapshot> =>
  Object.fromEntries(
    stepRuns.map((stepRun) => [
      stepRun.stepKey,
      {
        input: stepRun.input,
        output: stepRun.output,
        status: stepRun.status,
      },
    ]),
  )

export const buildAgentTaskBody = (
  stepInput: Record<string, unknown>,
  workflowInput: unknown,
  taintedRefs: ReadonlySet<string>,
): string => {
  // W0: the prompt is a sink. A pre-boundary persisted step input can still
  // carry a ref verbatim; redact before the body reaches the agent.
  const publicStepInput = stripWorkflowDesignerConfig(
    redactWorkflowSecretValues(stepInput, taintedRefs) as Record<string, unknown>,
  )
  const prompt = typeof publicStepInput['prompt'] === 'string' ? publicStepInput['prompt'].trim() : ''
  if (prompt) {
    return prompt
  }

  return JSON.stringify(
    {
      step: publicStepInput,
      workflowInput: redactWorkflowSecretValues(workflowInput, taintedRefs),
    },
    null,
    2,
  )
}

const parseWorkflowStartedByActorType = (
  value: string,
): 'agent' | 'service' | 'user' => {
  if (value === 'agent' || value === 'service' || value === 'user') {
    return value
  }

  throw new Error(`WORKFLOW_ACTOR_TYPE_INVALID:${value}`)
}

const buildWorkflowExecutionActorContext = (input: {
  channelId?: string | null
  organizationId: string
  projectId?: string | null
  stepRunId: string
  teamId?: string | null
  workflowRunId: string
  workflowStartedByActorId: string
  workflowStartedByActorType: string
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.workflowStartedByActorId,
    actorType: parseWorkflowStartedByActorType(input.workflowStartedByActorType),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    ...(input.projectId ? { projectId: parseProjectId(input.projectId) } : {}),
    ...(input.teamId ? { teamId: parseTeamId(input.teamId) } : {}),
    ...(input.channelId ? { channelId: parseChannelId(input.channelId) } : {}),
  },
  actionContext: {
    requestId: `workflow-environment:${input.stepRunId}`,
    correlationId: input.workflowRunId,
    ...(input.channelId ? { channelId: parseChannelId(input.channelId) } : {}),
    purpose: 'workflow.environment.allocate',
    sessionId: input.workflowRunId,
  },
})

const createWorkflowMailboxMessage = async (
  prisma: Prisma.TransactionClient,
  input: {
    actorId: string
    actorType: 'agent' | 'service' | 'user'
    body: string
    channelId?: string | null
    fromAgentId?: string | null
    organizationId: string
    subject?: string
    threadId?: string
    toAgentId: string
    workflowRunId: string
    workflowStepRunId: string
  },
): Promise<{ id: string }> => {
  const correlationId = `workflow-step:${input.workflowStepRunId}`

  try {
    return await prisma.agentMailboxMessage.create({
      data: {
        organizationId: input.organizationId,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        actorId: input.actorId,
        actorType: input.actorType,
        fromAgentId: input.fromAgentId ?? undefined,
        toAgentId: input.toAgentId,
        channelId: input.channelId ?? undefined,
        threadId: input.threadId,
        subject: input.subject,
        body: input.body,
        correlationId,
      },
      select: { id: true },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.agentMailboxMessage.findFirst({
        where: {
          organizationId: input.organizationId,
          toAgentId: input.toAgentId,
          correlationId,
        },
        select: { id: true },
      })
      if (existing) {
        return existing
      }
    }
    throw error
  }
}

// W28: the agent_task target check runs INSIDE the mailbox transaction (a
// channel or binding deleted between a pre-check and the insert was a race)
// and fails with one org-generic message — the old per-check error strings
// confirmed or denied the existence of channel, thread and binding ids
// across the org boundary. Locked (FOR UPDATE) inside the tx so a
// concurrent unbind/delete cannot slip between the read and the insert.
const assertWorkflowAgentTaskTargetInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    channelId: string
    organizationId: string
    threadId?: string
    toAgentId: string
  },
): Promise<void> => {
  // Sequential, in a fixed lock order (channel → binding → thread) so two
  // concurrent runs cannot deadlock against each other.
  const channels = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM channels
    WHERE id = ${input.channelId}::uuid
      AND organization_id = ${input.organizationId}::uuid
      AND system_channel_type IS NULL
    FOR UPDATE
  `
  const bindings =
    channels.length > 0
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT ab.id FROM agent_bindings ab
          JOIN agents a ON a.id = ab.agent_id AND a.agent_kind = 'shared'
          WHERE ab.agent_id = ${input.toAgentId}::uuid
            AND ab.channel_id = ${input.channelId}::uuid
          FOR UPDATE OF ab
        `
      : []
  const threads =
    channels.length > 0 && input.threadId
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT t.id FROM threads t
          WHERE t.id = ${input.threadId}::uuid
            AND t.channel_id = ${input.channelId}::uuid
          FOR UPDATE OF t
        `
      : input.threadId
        ? []
        : [{ id: '' }]

  if (
    channels.length === 0 ||
    bindings.length === 0 ||
    threads.length === 0
  ) {
    // Org-generic on purpose: which leg failed must not leak whether the
    // referenced channel/thread/binding exists in another organization.
    throw new Error('Agent task target is unavailable for this workflow run.')
  }
}

const validateWorkflowEnvironmentLaunch = async (
  prisma: PrismaClient,
  input: {
    channelId?: string
    organizationId: string
    templateId: string
  },
): Promise<{
    template: {
      id: string
      mode: 'container' | 'function' | 'vm'
      provider: 'docker' | 'gcloud'
    }
  }> => {
  const template = await prisma.executionEnvironmentTemplate.findFirst({
    where: {
      id: input.templateId,
      organizationId: input.organizationId,
      enabled: true,
    },
    select: {
      id: true,
      mode: true,
      provider: true,
    },
  })
  if (!template) {
    throw new Error('WORKFLOW_ENVIRONMENT_TEMPLATE_NOT_FOUND')
  }

  if (input.channelId) {
    const channel = await prisma.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
      },
      select: { id: true },
    })
    if (!channel) {
      throw new Error('WORKFLOW_ENVIRONMENT_CHANNEL_NOT_FOUND')
    }
  }

  return { template }
}

type LoadedWorkflowGraph = NonNullable<Awaited<ReturnType<typeof loadWorkflowGraph>>>

// Wraps the run/workflows.js step- and run-finish primitives so every place a
// workflow run can reach a terminal state (a step failure, which always fails
// the run per computeWorkflowStepFinishTransition, or the last step
// completing) also emits the `workflow.run.completed` / `workflow.run.failed`
// system event. Safe to call from multiple sites for the same run: the
// dedupe key in emitWorkflowRunTerminalEvent collapses duplicate enqueues.
const markWorkflowStepRunFinished = async (
  prisma: PrismaClient,
  workflow: LoadedWorkflowGraph,
  input: Parameters<typeof markWorkflowStepRunFinishedRaw>[1],
): ReturnType<typeof markWorkflowStepRunFinishedRaw> => {
  const result = await markWorkflowStepRunFinishedRaw(prisma, input)

  // The guarded transition lost to a concurrent terminalization (cancel or a
  // sibling step failure): that transition owns the terminal event, so emit
  // nothing for a write that never landed.
  if (!result.applied) {
    return result
  }

  if (!input.success) {
    await emitWorkflowRunTerminalEvent(
      prisma,
      buildWorkflowRunEventContext(workflow),
      'failed',
      input.summary,
    )
  } else if (result.workflowRunCompleted) {
    await emitWorkflowRunTerminalEvent(prisma, buildWorkflowRunEventContext(workflow), 'completed')
  }

  return result
}

const markWorkflowRunFinished = async (
  prisma: PrismaClient,
  workflow: LoadedWorkflowGraph,
  input: Parameters<typeof markWorkflowRunFinishedRaw>[1],
): ReturnType<typeof markWorkflowRunFinishedRaw> => {
  const result = await markWorkflowRunFinishedRaw(prisma, input)
  if (!result.applied) {
    return result
  }
  await emitWorkflowRunTerminalEvent(
    prisma,
    buildWorkflowRunEventContext(workflow),
    input.success ? 'completed' : 'failed',
    input.summary,
  )
  return result
}

export const executeWorkflowRun = async (
  execution: {
    actorContext: AuthorizedActionContext
    ledgerIdentity: LedgerIdentityService | null
    prisma: PrismaClient
    workflowRunId: string
  },
): Promise<void> => {
  const {
    ledgerIdentity,
    prisma,
    workflowRunId,
  } = execution
  const workflow = await loadWorkflowGraph(prisma, workflowRunId)
  if (!workflow) {
    return
  }
  if (workflow.run.status === 'completed' || workflow.run.status === 'failed' || workflow.run.status === 'cancelled') {
    return
  }

  const claimedTenant = execution.actorContext.tenant
  const durableActorType = parseWorkflowStartedByActorType(
    workflow.run.startedByActorType,
  )
  const identityMismatch =
    execution.actorContext.actor.actorId !== workflow.run.startedByActorId
    || execution.actorContext.actor.actorType !== durableActorType
  const scopeMismatch =
    claimedTenant.organizationId !== workflow.run.organizationId
    || Boolean(
      claimedTenant.teamId
      && workflow.installation.teamId
      && claimedTenant.teamId !== workflow.installation.teamId,
    )
    || Boolean(
      claimedTenant.projectId
      && workflow.installation.projectId
      && claimedTenant.projectId !== workflow.installation.projectId,
    )
    || Boolean(
      claimedTenant.channelId
      && workflow.installation.channelId
      && claimedTenant.channelId !== workflow.installation.channelId,
    )
  if (identityMismatch || scopeMismatch) {
    await markWorkflowRunFinished(prisma, workflow, {
      workflowRunId,
      success: false,
      summary: identityMismatch
        ? 'Workflow execution actor does not match its durable origin.'
        : 'Workflow execution scope does not match its durable installation.',
    })
    return
  }

  const actorContext: AuthorizedActionContext = {
    ...execution.actorContext,
    tenant: {
      ...claimedTenant,
      organizationId: parseOrganizationId(workflow.run.organizationId),
      ...(workflow.installation.projectId
        ? { projectId: parseProjectId(workflow.installation.projectId) }
        : {}),
      ...(workflow.installation.teamId
        ? { teamId: parseTeamId(workflow.installation.teamId) }
        : {}),
      ...(workflow.installation.channelId
        ? { channelId: parseChannelId(workflow.installation.channelId) }
        : {}),
    },
    actionContext: {
      ...execution.actorContext.actionContext,
      ...(workflow.installation.channelId
        ? { channelId: parseChannelId(workflow.installation.channelId) }
        : {}),
    },
  }

  const materialization = await ensureWorkflowStepRuns(prisma, {
    workflowRunId,
    steps: workflow.graph.steps,
  })

  // Step rows already materialized but their identities disagree with the
  // snapshot: only possible when the backfill migration froze the CURRENT
  // template onto a run suspended mid-flight (its rows came from the OLD
  // template). Treat the template the rows came from as the run's graph and
  // re-pin it, so the continuation does not interleave old and new steps.
  // Pre-snapshot rows executing from the live template (graph_snapshot NULL)
  // take loadWorkflowGraph's fallback and never reach this branch.
  if (materialization.alreadyMaterialized && workflow.installation.pinnedGraphJson == null) {
    const stepRuns = await listWorkflowStepRuns(prisma, workflowRunId)
    const snapshotKeys = workflow.graph.steps.map((step) => step.id)
    const drifted =
      snapshotKeys.length !== stepRuns.length ||
      stepRuns.some((stepRun, index) => stepRun.stepKey !== snapshotKeys[index])
    if (drifted) {
      const materializedGraph = {
        steps: stepRuns.map((stepRun) => ({
          id: stepRun.stepKey,
          input:
            stepRun.input && typeof stepRun.input === 'object' && !Array.isArray(stepRun.input)
              ? (stepRun.input as Record<string, unknown>)
              : {},
          title: stepRun.title,
          type: stepRun.stepType,
        })),
      }
      await reconcileWorkflowRunGraphSnapshot(prisma, {
        graph: materializedGraph,
        workflowRunId,
      })
      workflow.graph = materializedGraph
    }
  }

  if (workflow.run.status === 'pending') {
    await markWorkflowRunStarted(prisma, workflowRunId)
  }

  while (true) {
    const stepRuns = await listWorkflowStepRuns(prisma, workflowRunId)
    const runningStep = stepRuns.find((step) => step.status === 'running')
    if (runningStep) {
      return
    }

    const nextStep = stepRuns.find((step) => step.status === 'pending')
    if (!nextStep) {
      await markWorkflowRunFinished(prisma, workflow, {
        workflowRunId,
        success: true,
        summary: 'Workflow run completed.',
      })
      return
    }

    const stepDefinition = workflow.graph.steps[nextStep.sequence]
    if (!stepDefinition) {
      await markWorkflowStepRunFinished(prisma, workflow, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary: 'Workflow step definition missing from template graph.',
      })
      return
    }

    let resolvedStepInput: unknown
    try {
      resolvedStepInput = resolveWorkflowStepInput(
        stepDefinition.input ?? {},
        buildWorkflowBindingContext({
          stepSnapshots: buildWorkflowStepSnapshots(stepRuns),
          workflowBindings: workflow.installation.resolvedBindings,
          workflowConfig: workflow.installation.config,
          workflowInput: workflow.run.input,
        }),
      )
    } catch (error) {
      await markWorkflowStepRunFinished(prisma, workflow, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary:
          error instanceof Error
            ? error.message
            : 'Workflow step input binding resolution failed.',
      })
      return
    }

    if (
      !resolvedStepInput ||
      typeof resolvedStepInput !== 'object' ||
      Array.isArray(resolvedStepInput)
    ) {
      await markWorkflowStepRunFinished(prisma, workflow, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary: 'Workflow step input must resolve to an object.',
      })
      return
    }

    const stepInput = resolvedStepInput as Record<string, unknown>
    const runtimeStepType =
      stepDefinition.type === 'tool'
        ? 'tool_call'
        : stepDefinition.type === 'agent'
          ? 'agent_task'
          : stepDefinition.type

    if (runtimeStepType === 'tool_call') {
      const toolName = typeof stepInput['toolName'] === 'string' ? stepInput['toolName'] : ''
      if (!toolName) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Tool call step requires toolName.',
        })
        return
      }

      const toolArgs = Object.fromEntries(
        Object.entries(stripWorkflowDesignerConfig(stepInput)).filter(
          ([key]) => key !== 'toolName',
        ),
      )

      const leaseOwnerId = randomUUID()
      await markWorkflowStepRunStarted(prisma, {
        input: stepInput,
        leaseOwnerId,
        output: {
          input: toolArgs,
          toolName,
        },
        stepRunId: nextStep.id,
      })

      // Heartbeat while the tool runs so a legitimately long call is never
      // reclaimed; a crashed worker stops heartbeating and the reaper takes
      // the step by its expired lease.
      const leaseHeartbeat = setInterval(() => {
        void heartbeatWorkflowStepLease(prisma, {
          ownerId: leaseOwnerId,
          stepRunId: nextStep.id,
        }).catch((error) => {
          console.error('[worker.workflow-step-lease] heartbeat failed', error)
        })
      }, WORKFLOW_STEP_LEASE_HEARTBEAT_MS)
      leaseHeartbeat.unref()

      try {
        const toolContext: WorkflowBuiltinToolRuntimeContext = {
          actorContext,
          ledgerIdentity,
          organizationId: workflow.run.organizationId,
          prisma,
          workflowInstallationId: workflow.installation.id,
          workflowRunId,
          workflowStepRunId: nextStep.id,
        }
        const toolResult = await executeWorkflowBuiltinTool(toolName, toolArgs, toolContext)

        const finishResult = await markWorkflowStepRunFinished(prisma, workflow, {
          output: {
            result: toolResult.output,
            toolName,
          },
          workflowRunId,
          stepRunId: nextStep.id,
          success: toolResult.success,
          summary: toolResult.summary,
        })

        if (!toolResult.success || finishResult.workflowRunCompleted || !finishResult.continueWorkflow) {
          return
        }
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary:
            error instanceof Error
              ? error.message
              : `Workflow tool call failed: ${toolName}`,
        })
        return
      } finally {
        clearInterval(leaseHeartbeat)
      }

      continue
    }

    if (runtimeStepType === 'agent_task') {
      const toAgentId = typeof stepInput['agentId'] === 'string' ? stepInput['agentId'] : undefined
      const channelId =
        typeof stepInput['channelId'] === 'string'
          ? stepInput['channelId']
          : workflow.installation.channelId
      const threadId = typeof stepInput['threadId'] === 'string' ? stepInput['threadId'] : undefined

      if (!toAgentId || !channelId) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Agent task step requires agentId and channelId.',
        })
        return
      }

      // W28: validation + mailbox insert in one transaction. A throw rolls
      // both back; the step is then finished below (outside the tx) with the
      // org-generic message.
      let mailboxMessage: { id: string }
      try {
        mailboxMessage = await prisma.$transaction(async (tx) => {
          await assertWorkflowAgentTaskTargetInTransaction(tx, {
            organizationId: workflow.run.organizationId,
            toAgentId,
            channelId,
            threadId,
          })
          return createWorkflowMailboxMessage(tx, {
            actorId: workflow.run.startedByActorId,
            actorType: parseWorkflowStartedByActorType(workflow.run.startedByActorType),
            organizationId: workflow.run.organizationId,
            workflowRunId,
            workflowStepRunId: nextStep.id,
            fromAgentId:
              workflow.run.startedByActorType === 'agent' ? workflow.run.startedByActorId : null,
            toAgentId,
            channelId,
            threadId,
            subject: typeof stepInput['subject'] === 'string' ? stepInput['subject'] : undefined,
            body: buildAgentTaskBody(
              stepInput,
              workflow.run.input,
              collectWorkflowTaintedRefs(workflow.installation.resolvedBindings),
            ),
          })
        })
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: error instanceof Error ? error.message : 'Invalid workflow agent task target.',
        })
        return
      }

      await markWorkflowStepRunQueued(prisma, {
        input: stepInput,
        workflowRunId,
        workflowStepRunId: nextStep.id,
        output: {
          mailboxMessageId: mailboxMessage.id,
          targetAgentId: toAgentId,
        },
      })
      return
    }

    if (runtimeStepType === 'environment_launch') {
      const boundTemplateId = resolveBoundValue(
        workflow.installation.resolvedBindings,
        stepInput['templateBindingKey'],
      )
      const templateId =
        typeof stepInput['templateId'] === 'string'
          ? stepInput['templateId']
          : typeof boundTemplateId === 'string'
            ? boundTemplateId
            : undefined

      if (!templateId) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Environment launch step requires templateId or templateBindingKey.',
        })
        return
      }

      const resolvedChannelId =
        typeof stepInput['channelId'] === 'string'
          ? stepInput['channelId']
          : workflow.installation.channelId

      try {
        await validateWorkflowEnvironmentLaunch(prisma, {
          organizationId: workflow.run.organizationId,
          templateId,
          channelId: resolvedChannelId ?? undefined,
        })
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, workflow, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary:
            error instanceof Error
              ? error.message
              : 'Invalid workflow environment launch target.',
        })
        return
      }

      const actorContext = buildWorkflowExecutionActorContext({
        channelId: resolvedChannelId,
        organizationId: workflow.run.organizationId,
        projectId: workflow.installation.projectId,
        stepRunId: nextStep.id,
        teamId: workflow.installation.teamId,
        workflowRunId,
        workflowStartedByActorId: workflow.run.startedByActorId,
        workflowStartedByActorType: workflow.run.startedByActorType,
      })

      await prisma.$transaction(async (tx) => {
        const created = await tx.executionEnvironmentInstance.create({
          data: {
            templateId,
            organizationId: workflow.run.organizationId,
            projectId: workflow.installation.projectId,
            teamId: workflow.installation.teamId,
            channelId: resolvedChannelId,
            workflowRunId,
            workflowStepRunId: nextStep.id,
            launchedByActorType: workflow.run.startedByActorType,
            launchedByActorId: workflow.run.startedByActorId,
            launchConfig: stepInput as Prisma.InputJsonValue,
          },
          select: { id: true },
        })

        await markWorkflowStepRunQueued(tx, {
          input: stepInput,
          workflowRunId,
          workflowStepRunId: nextStep.id,
          output: {
            environmentInstanceId: created.id,
            status: 'pending',
          },
        })

        await enqueueQueueJob(tx, {
          idempotencyKey: `execution-environment:${created.id}`,
          payload: {
            actorContext,
            instanceId: created.id,
          },
          topic: 'execution.environment.allocate',
        })
      })
      return
    }

    await markWorkflowStepRunStarted(prisma, { input: stepInput, stepRunId: nextStep.id })
    await markWorkflowStepRunFinished(prisma, workflow, {
      workflowRunId,
      stepRunId: nextStep.id,
      success: false,
      summary: `Unsupported workflow step type: ${runtimeStepType}`,
    })
    return
  }
}
