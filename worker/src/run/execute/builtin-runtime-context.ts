import {
  parseOrganizationId,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import type { JudgedGmailDraftAuthorization } from '@nessie/team-admin'

import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * Assemble the non-model-facing runtime supplied to every builtin invocation.
 * Keeping this outside the loop lets dispatch carry authorization facts without
 * teaching individual tool handlers about queue or continuation internals.
 */
export const buildBuiltinRuntimeContext = (input: {
  approvalProofClaimedForTool?: string
  judgedGmailDraftAuthorization?: JudgedGmailDraftAuthorization
  context: RunContext
  deps: ExecutionDependencies
  payload: Pick<RunExecuteJobPayload, 'interactive' | 'messageId'>
  toolActorContext: AuthorizedActionContext
  toolCallId: string
}) => ({
  agentId: input.context.agent.id,
  agentKind: input.context.agent.agentKind,
  actorContext: input.toolActorContext,
  authorization: {
    approvalProofClaimedForTool: input.approvalProofClaimedForTool,
    judgedGmailDraftAuthorization: input.judgedGmailDraftAuthorization,
  },
  demonstrationControl: {
    clearActive: () => {
      input.context.activeDemonstrationId = null
    },
    setActive: (demonstrationId: string) => {
      input.context.activeDemonstrationId = demonstrationId
    },
  },
  channel: {
    id: input.context.channel.id,
    organizationId: parseOrganizationId(input.context.channel.organizationId),
    systemChannelType: input.context.channel.systemChannelType,
    teamId: input.context.channel.teamId ?? null,
  },
  agentIdentity: {
    ownerUserId: input.context.agent.ownerUserId ?? null,
    visibility: (input.context.agent.visibility === 'private' ? 'private' : 'team') as
      'private' | 'team',
  },
  cloudBrowser: input.deps.cloudBrowser,
  consumedSources: input.context.consumedSources,
  documentStream: input.deps.documentStream,
  executorCommandEncryptionSecret: input.deps.executorCommandEncryptionSecret,
  ledgerIdentity: input.deps.ledgerIdentity ?? null,
  mcpSecrets: input.deps.mcpSecrets,
  memoryCaptureConfig: {
    modelClient: input.deps.modelClient,
    pool: input.deps.searchConfig.pool,
  },
  modelClient: input.deps.modelClient,
  prisma: input.deps.prisma,
  realtimeTransport: input.deps.realtimeTransport,
  run: {
    id: input.context.run.id,
    interactive: input.payload.interactive === true,
    messageId: input.payload.messageId,
    principalUserId: input.context.run.principalUserId,
    originatingUserId:
      input.toolActorContext.actionContext.effectiveUserId
      ?? (input.toolActorContext.actor.actorType === 'user'
        ? input.toolActorContext.actor.actorId
        : null),
    threadId: input.context.run.threadId,
  },
  runContext: input.context,
  toolCallId: input.toolCallId,
})
