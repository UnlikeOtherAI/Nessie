import {
  getExecutorAccessView,
  getExecutorForUser,
  listVisibleExecutors,
  prepareExecutorAccessChange,
  prepareExecutorWorkspacePromotion,
  type ExecutorAccessChange,
} from '@nessie/executor-manage'
import { writeAuditEntry } from '@nessie/db'
import {
  ImplementedExecutorOperationKeySchema,
  parseAgentId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import { formatSection } from './tool-output.js'

const requireExecutorPersonalAssistant = (
  context: BuiltinToolRuntimeContext,
): AuthorizedActionContext => {
  const userId = requireActingUserId(context)
  if (
    context.agentKind !== 'personal_assistant'
    || context.channel.systemChannelType !== 'personal_assistant'
    || context.run.originatingUserId !== userId
  ) {
    throw new Error(
      'Executor management is available only in the requesting user’s Personal Assistant conversation.',
    )
  }
  return {
    ...context.actorContext,
    actor: { actorId: parseUserId(userId), actorType: 'user' },
    actionContext: {
      ...context.actorContext.actionContext,
      agentId: parseAgentId(context.agentId),
      effectiveUserId: parseUserId(userId),
    },
  }
}

const requireId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`)
  }
  return value
}

const formatExecutor = (executor: {
  id: string
  label: string
  profiles: string[]
  scope: { kind: string; projectId?: string }
  status: string
  statusDetail?: string
}): string => [
  `- ${executor.label} | scope=${executor.scope.kind} | status=${executor.status} | executorId=${executor.id}`,
  `  profiles=${executor.profiles.join(', ') || 'none'}`,
  executor.scope.projectId ? `  projectId=${executor.scope.projectId}` : null,
  executor.statusDetail ? `  status detail: ${executor.statusDetail}` : null,
].filter((line): line is string => line !== null).join('\n')

const reviewLink = (prepared: { accessChangeId: string; confirmationToken: string }): string =>
  `/agents/executors?accessChange=${prepared.accessChangeId}#confirmationToken=${prepared.confirmationToken}`

const promotionReviewLink = (prepared: { confirmationToken: string; promotionId: string }): string =>
  `/agents/executors?promotion=${prepared.promotionId}#confirmationToken=${prepared.confirmationToken}`

const auditPreparedAccessChange = async (
  context: BuiltinToolRuntimeContext,
  actorContext: AuthorizedActionContext,
  prepared: {
    accessChangeId: string
    executorId: string
    requiresFreshVerification: boolean
  },
): Promise<void> => {
  try {
    await writeAuditEntry(context.prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
      channelId: context.channel.id,
      actorType: 'user',
      actorId: actorContext.actor.actorId,
      action: 'executor.access_change.prepared',
      resourceType: 'executor_access_change',
      resourceId: prepared.accessChangeId,
      outcome: 'success',
      metadata: {
        delegatedByAgentId: context.agentId,
        executorId: prepared.executorId,
        requiresFreshVerification: prepared.requiresFreshVerification,
        runId: context.run.id,
      },
      requestId: actorContext.actionContext.requestId,
    })
  } catch {
    console.error('[executor] Failed to emit access-change audit event')
  }
}

const prepare = async (
  context: BuiltinToolRuntimeContext,
  executorId: string,
  change: ExecutorAccessChange,
): Promise<ToolExecutionResult> => {
  const actorContext = requireExecutorPersonalAssistant(context)
  const prepared = await prepareExecutorAccessChange(context.prisma, actorContext, {
    executorId,
    change,
  })
  await auditPreparedAccessChange(context, actorContext, prepared)
  return {
    inputSummary: `executorId=${executorId} change=${change.kind}`,
    outputPreview:
      `Prepared executor access change ${prepared.accessChangeId}. It expires at ${prepared.expiresAt.toISOString()}. `
      + `The requesting user must review and confirm it here: ${reviewLink(prepared)} `
      + (prepared.requiresFreshVerification
        ? 'Fresh account verification is required before it can be applied.'
        : 'The confirmation control is required before it can be applied.'),
    toolName: 'executor_access_prepare',
  }
}

export const runExecutorListTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  const actorContext = requireExecutorPersonalAssistant(context)
  const executors = await listVisibleExecutors(context.prisma, actorContext)
  return {
    inputSummary: '',
    outputPreview:
      formatSection(`Executors (${executors.length})`, executors.map(formatExecutor))
      || 'No executors are available to you. Open /agents/executors to pair one.',
    toolName: 'executor_list',
  }
}

export const runExecutorInspectTool = async (
  context: BuiltinToolRuntimeContext,
  input: { executorId: unknown },
): Promise<ToolExecutionResult> => {
  const actorContext = requireExecutorPersonalAssistant(context)
  const executorId = requireId(input.executorId, 'executorId')
  const [found, access] = await Promise.all([
    getExecutorForUser(context.prisma, actorContext, executorId),
    getExecutorAccessView(context.prisma, actorContext, executorId),
  ])
  if (!found) throw new Error('Executor not found.')
  const descriptorRevisions = access?.canManage
    ? formatSection(
        'Local policy proposals',
        (access.descriptorRevisions ?? []).map((revision) => (
          `- revision=${revision.revision} status=${revision.reviewStatus} `
          + `operations=${revision.operationKeys.join(', ')} digest=${revision.localPolicyDigest}`
        )),
      )
    : null
  return {
    inputSummary: `executorId=${executorId}`,
    outputPreview:
      `${formatExecutor(found.executor)}\n  access=your entitlement only\n  manage=${access?.canManage === true}`
      + (descriptorRevisions ? `\n${descriptorRevisions}` : ''),
    toolName: 'executor_inspect',
  }
}

export const runExecutorPairTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  requireExecutorPersonalAssistant(context)
  return {
    inputSummary: '',
    outputPreview:
      'Open /agents/executors to pair an executor. You will choose its immutable private, project, or organization scope; '
      + 'private pairing also requires exact human and agent assignments. The companion then completes the signed pairing.',
    toolName: 'executor_pair',
  }
}

export const runExecutorLifecyclePrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: { action: 'pause' | 'drain' | 'revoke'; executorId: unknown },
): Promise<ToolExecutionResult> => prepare(
  context,
  requireId(input.executorId, 'executorId'),
  { kind: 'lifecycle', action: input.action },
)

export const runExecutorDescriptorReviewPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: { executorId: unknown; revision: unknown; status: unknown },
): Promise<ToolExecutionResult> => {
  if (typeof input.revision !== 'number' || !Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error('revision must be a positive integer.')
  }
  if (input.status !== 'active' && input.status !== 'disabled') {
    throw new Error('status must be active or disabled.')
  }
  return prepare(context, requireId(input.executorId, 'executorId'), {
    kind: 'descriptor_review',
    revision: input.revision,
    status: input.status,
  })
}

export const runExecutorAgentAccessPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: { agentId: unknown; executorId: unknown; operationKey: unknown; state: unknown },
): Promise<ToolExecutionResult> => {
  const operationKey = ImplementedExecutorOperationKeySchema.safeParse(input.operationKey)
  if (!operationKey.success) throw new Error('operationKey is not an implemented executor operation.')
  if (input.state !== 'allowed' && input.state !== 'denied') {
    throw new Error('state must be allowed or denied.')
  }
  return prepare(context, requireId(input.executorId, 'executorId'), {
    kind: 'agent_operation_grant',
    agentId: requireId(input.agentId, 'agentId'),
    operationKey: operationKey.data,
    state: input.state,
  })
}

export const runExecutorPrivateAssignmentPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    action: unknown
    executorId: unknown
    principalId: unknown
    principalKind: unknown
    role: unknown
  },
): Promise<ToolExecutionResult> => {
  const executorId = requireId(input.executorId, 'executorId')
  const principalId = requireId(input.principalId, 'principalId')
  if (input.principalKind !== 'user' && input.principalKind !== 'agent') {
    throw new Error('principalKind must be user or agent.')
  }
  if (input.action === 'remove') {
    return prepare(context, executorId, {
      kind: 'private_assignment',
      action: 'remove',
      principal: input.principalKind === 'user'
        ? { principalKind: 'user', userId: principalId }
        : { principalKind: 'agent', agentId: principalId },
    })
  }
  if (input.action !== 'set') throw new Error('action must be set or remove.')
  if (input.principalKind === 'user' && (input.role === 'use' || input.role === 'admin')) {
    return prepare(context, executorId, {
      kind: 'private_assignment',
      action: 'set',
      assignment: { principalKind: 'user', userId: principalId, role: input.role },
    })
  }
  if (input.principalKind === 'agent' && (input.role === undefined || input.role === 'use')) {
    return prepare(context, executorId, {
      kind: 'private_assignment',
      action: 'set',
      assignment: { principalKind: 'agent', agentId: principalId, role: 'use' },
    })
  }
  throw new Error('User roles must be use or admin; agent assignments always use role use.')
}

/** The PA can prepare the originating user’s exact draft, but never promote it. */
export const runExecutorWorkspacePromotionPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: { reviewCommandId: unknown },
): Promise<ToolExecutionResult> => {
  const actorContext = requireExecutorPersonalAssistant(context)
  const encryptionSecret = context.executorCommandEncryptionSecret
  if (!encryptionSecret) {
    throw new Error('Executor promotion review is unavailable because encrypted executor receipt access is not configured.')
  }
  const reviewCommandId = requireId(input.reviewCommandId, 'reviewCommandId')
  const prepared = await prepareExecutorWorkspacePromotion(
    context.prisma,
    encryptionSecret,
    actorContext,
    { reviewCommandId },
  )
  try {
    await writeAuditEntry(context.prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
      channelId: context.channel.id,
      actorType: 'user',
      actorId: actorContext.actor.actorId,
      action: 'executor.workspace_promotion.prepared',
      resourceType: 'executor_workspace_promotion',
      resourceId: prepared.promotionId,
      outcome: 'success',
      metadata: {
        delegatedByAgentId: context.agentId,
        executorId: prepared.executorId,
        manifestDigest: prepared.manifestDigest,
        reviewCommandId,
        runId: context.run.id,
      },
      requestId: actorContext.actionContext.requestId,
    })
  } catch {
    console.error('[executor] Failed to emit workspace-promotion audit event')
  }
  return {
    inputSummary: `reviewCommandId=${reviewCommandId}`,
    outputPreview:
      `Prepared workspace promotion ${prepared.promotionId}. It expires at ${prepared.expiresAt.toISOString()}. `
      + `The requesting user must inspect and password-confirm it here: ${promotionReviewLink(prepared)}`,
    toolName: 'executor_workspace_promotion_prepare',
  }
}
