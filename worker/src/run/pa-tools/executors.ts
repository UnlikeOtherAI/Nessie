import {
  EXECUTOR_REVIEW_CARD_ACTION_KEY,
  formatExecutorLocalMcp,
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
import { runDelegatesToRequestingPerson } from '../delegated-identity.js'
import { requireActingUserId } from './access.js'
import { postAgentCard } from './agent-card-post.js'
import { formatSection } from './tool-output.js'

/**
 * The surface an executor tool may act on: a run that delegates to the person
 * it is talking to, in that person's own private room.
 *
 * It used to be keyed on `agentKind === 'personal_assistant'` plus the PA's own
 * channel type. That is the defect `runDelegatesToRequestingPerson` was written
 * to remove — the Agent Designer is `agentKind: 'shared'` and delegates just as
 * completely inside its own home DM, so keying on the kind made the whole
 * executor estate invisible to it with no failing check anywhere.
 *
 * The predicate replaces the kind test, NOT the equality test below it. Both
 * arms of the predicate are surface-keyed, so a shared channel and a
 * non-delegating agent are still refused; `originatingUserId === actingUserId`
 * is what additionally refuses an unattended run, which has no requester to act
 * as and must never reconstruct one.
 */
const requireDelegatedExecutorSurface = (
  context: BuiltinToolRuntimeContext,
): AuthorizedActionContext => {
  const userId = requireActingUserId(context)
  const runContext = context.runContext
  if (
    !runContext
    || !runDelegatesToRequestingPerson({
      agentKind: runContext.agent.agentKind,
      dmKey: runContext.channel.dmKey,
      organizationId: runContext.channel.organizationId,
      systemChannelType: runContext.channel.systemChannelType,
      systemSlug: runContext.agent.systemSlug,
    })
    || context.run.originatingUserId !== userId
  ) {
    throw new Error(
      'Executor management is available only in the requesting user’s own private '
      + 'conversation with an assistant that acts with their authority.',
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

/** What the change does, in the card's own words; the review shows the rest. */
const reviewCardSubtitle = (change: ExecutorAccessChange): string => {
  switch (change.kind) {
    case 'lifecycle':
      return {
        drain: 'Stop this executor accepting work',
        pause: 'Pause this executor',
        resume: 'Resume this executor',
        revoke: 'Disconnect this executor',
        remove: 'Delete this executor',
      }[change.action]
    case 'descriptor_review':
      return change.status === 'active'
        ? `Approve revision ${change.revision} of this executor’s permissions`
        : `Disable revision ${change.revision} of this executor’s permissions`
    case 'private_assignment':
      return change.action === 'set'
        ? 'Change who can use this executor'
        : 'Remove access to this executor'
    // Posted by its own tool with its own card (`provisioning-standing-policy.ts`).
    case 'standing_policy':
      return 'Give an agent standing access to your machines'
    default:
      return change.state === 'allowed'
        ? 'Give an agent access to this executor'
        : 'Remove an agent’s access to this executor'
  }
}

/**
 * The confirmation card a prepared access change or workspace promotion is
 * reviewed through.
 *
 * Both used to come back as a review link carrying the confirmation token in
 * the fragment. That token is a secret the model must never see, and the
 * secret scanner rightly redacted it from the tool output — so the link the
 * Designer posted opened a review with no token, and the change could not be
 * confirmed from chat at all. The card holds only the change's id and asks
 * only the person who prepared it; every press of Review mints a fresh token
 * for that person (`@nessie/executor-manage` `executor-review-cards.ts`) and
 * opens the existing review with it, and the card stays open until the change
 * is confirmed, rejected or expires. The token prepared here is discarded
 * unseen. Confirming is unchanged: same actor, the token, fresh verification
 * where the change needs it.
 */
const postReviewCard = async (
  context: BuiltinToolRuntimeContext,
  actorContext: AuthorizedActionContext,
  review: {
    change: { accessChangeId: string } | { promotionId: string }
    expiresAt: Date
    requiresFreshVerification: boolean
    subtitle: string
    title: string
  },
): Promise<void> => {
  const runContext = context.runContext
  // Unreachable past the delegated surface check, which requires one.
  if (!runContext) throw new Error('Unable to resolve the current conversation.')
  const minutes = Math.max(1, Math.round((review.expiresAt.getTime() - Date.now()) / 60_000))
  await postAgentCard(context, runContext, {
    card: {
      actions: [{ key: EXECUTOR_REVIEW_CARD_ACTION_KEY, label: 'Review', style: 'primary', submits: true }],
      blocks: [{
        markdown:
          'Review opens exactly what changes. Nothing is applied until you confirm it there'
          + `${review.requiresFreshVerification ? ', with your password' : ''}. `
          + `This expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        type: 'text',
      }],
      schemaVersion: 1,
      subtitle: review.subtitle,
      title: review.title,
    },
    ...('accessChangeId' in review.change
      ? { executorAccessChangeId: review.change.accessChangeId }
      : { executorWorkspacePromotionId: review.change.promotionId }),
    expiresAt: review.expiresAt,
    respondentUserIds: [actorContext.actor.actorId],
  })
}

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
  const actorContext = requireDelegatedExecutorSurface(context)
  const prepared = await prepareExecutorAccessChange(context.prisma, actorContext, {
    executorId,
    change,
  })
  await auditPreparedAccessChange(context, actorContext, prepared)
  await postReviewCard(context, actorContext, {
    change: { accessChangeId: prepared.accessChangeId },
    expiresAt: prepared.expiresAt,
    requiresFreshVerification: prepared.requiresFreshVerification,
    subtitle: reviewCardSubtitle(change),
    title: 'Confirm an executor change',
  })
  return {
    // The card is this turn's message: it says what to do, so the run may end
    // without restating it.
    deliveredToConversation: true,
    inputSummary: `executorId=${executorId} change=${change.kind}`,
    outputPreview:
      'Prepared the change and put a confirmation card in this conversation. Its Review '
      + 'button opens the exact change for the requesting person; nothing is applied until '
      + 'they confirm it there'
      + (prepared.requiresFreshVerification ? ', with fresh account verification' : '')
      + `. It expires at ${prepared.expiresAt.toISOString()}.`,
    toolName: 'executor_access_prepare',
  }
}

export const runExecutorListTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  const actorContext = requireDelegatedExecutorSurface(context)
  const executors = await listVisibleExecutors(context.prisma, actorContext)
  return {
    inputSummary: '',
    outputPreview:
      formatSection(`Executors (${executors.length})`, executors.map(formatExecutor))
      || 'No executors are available to you. Open /agents/executors to pair one.',
    toolName: 'executor_list',
  }
}

/**
 * The local MCP summary, from the one definition in `@nessie/executor-manage`.
 *
 * Re-exported under its established name because it is not only this tool's
 * answer any more: the Agent Designer's generated design catalogue renders the
 * same three states, and two copies is how one of them quietly loses the
 * difference between "has never reported" and "reports nothing".
 */
export const formatLocalMcp = formatExecutorLocalMcp

export const runExecutorInspectTool = async (
  context: BuiltinToolRuntimeContext,
  input: { executorId: unknown },
): Promise<ToolExecutionResult> => {
  const actorContext = requireDelegatedExecutorSurface(context)
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
          + `operations=${revision.operationKeys.join(', ')} `
          // A person asked to approve a revision here reads this line and
          // nothing else, so "named none" has to be said rather than omitted.
          + `programs=${revision.commandAllowlist?.join(', ') ?? 'none named'} `
          // Same reading as the programs: a revision that names no MCP server
          // fronts none, and saying so beats omitting the word.
          + `mcpServers=${revision.mcpServers?.join(', ') ?? 'none named'} `
          + `digest=${revision.localPolicyDigest}`
        )),
      )
    : null
  return {
    inputSummary: `executorId=${executorId}`,
    outputPreview:
      `${formatExecutor(found.executor)}\n  access=your entitlement only\n  manage=${access?.canManage === true}`
      + (descriptorRevisions ? `\n${descriptorRevisions}` : '')
      + (access?.canManage === true
        ? `\n${formatLocalMcp(access.localMcp, access.localMcpObservedAt)}`
        : ''),
    toolName: 'executor_inspect',
  }
}

export const runExecutorPairTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  requireDelegatedExecutorSurface(context)
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

/**
 * Give one agent the whole suite an executor offers, as one prepared change.
 *
 * The product rule is that access to an executor is access to everything on
 * it, so this tool names no operation key: the set is derived when the person
 * confirms it, from the capability revision they themselves reviewed. That is
 * also what keeps it to ONE confirmation — the per-operation door would make
 * an ordinary "let the researcher use my Mac" a dozen separate reviews.
 */
export const runExecutorAgentGrantPrepareTool = async (
  context: BuiltinToolRuntimeContext,
  input: { agentId: unknown; executorId: unknown; state: unknown },
): Promise<ToolExecutionResult> => {
  if (input.state !== 'allowed' && input.state !== 'denied') {
    throw new Error('state must be allowed or denied.')
  }
  return prepare(context, requireId(input.executorId, 'executorId'), {
    kind: 'agent_executor_grant',
    agentId: requireId(input.agentId, 'agentId'),
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
  const actorContext = requireDelegatedExecutorSurface(context)
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
  // The same card as an access change, for the same reason: the token this
  // prepare minted must never reach the model, so it is discarded unseen and
  // the card's press mints the one that confirms.
  await postReviewCard(context, actorContext, {
    change: { promotionId: prepared.promotionId },
    expiresAt: prepared.expiresAt,
    requiresFreshVerification: true,
    subtitle: `Write ${prepared.changeCount} reviewed change${prepared.changeCount === 1 ? '' : 's'} to the host workspace`,
    title: 'Confirm a workspace promotion',
  })
  return {
    deliveredToConversation: true,
    inputSummary: `reviewCommandId=${reviewCommandId}`,
    outputPreview:
      'Prepared the promotion and put a confirmation card in this conversation. Its Review '
      + 'button opens the exact promotion for the requesting person; nothing is written until '
      + 'they confirm it there, with fresh account verification. '
      + `It expires at ${prepared.expiresAt.toISOString()}.`,
    toolName: 'executor_workspace_promotion_prepare',
  }
}
