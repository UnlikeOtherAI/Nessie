import { parseOrganizationId, type RunExecuteJobPayload } from '@nessie/schemas'
import { executeBuiltinTool } from '../tools.js'
import { summarizeToolInput } from '../tool-util.js'
import type { ToolActorContext, ToolAuthorizationDecision } from './tool-authorization.js'
import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * Execution-only authority added by the authorization chokepoint. These flags
 * are never derived from a model-provided tool payload.
 */
export type GmailSendAuthorization = {
  gmailDraftSendApproved?: true
  gmailDraftSendStandingAuthorized?: true
}

type BuiltinRuntimeContextInput = {
  deps: ExecutionDependencies
  payload: RunExecuteJobPayload
  context: RunContext
  stubbedBuiltinToolIds: Set<string>
}

/**
 * Builds the complete runtime context passed to builtin tools. Keeping this
 * boundary outside the agent loop makes the latter responsible only for
 * deciding when a tool runs, while this module carries approved capabilities
 * through to the handler that consumes them.
 */
export const createBuiltinToolExecutor = ({
  deps,
  payload,
  context,
  stubbedBuiltinToolIds,
}: BuiltinRuntimeContextInput) => {
  const buildContext = (
    toolActorContext: ToolActorContext,
    toolCallId: string,
    authorization: GmailSendAuthorization = {},
  ) => ({
    agentId: context.agent.id,
    agentKind: context.agent.agentKind,
    actorContext: toolActorContext,
    ...authorization,
    demonstrationControl: {
      clearActive: () => {
        context.activeDemonstrationId = null
      },
      setActive: (demonstrationId: string) => {
        context.activeDemonstrationId = demonstrationId
      },
    },
    channel: {
      id: context.channel.id,
      organizationId: parseOrganizationId(context.channel.organizationId),
      systemChannelType: context.channel.systemChannelType,
      teamId: context.channel.teamId ?? null,
    },
    agentIdentity: {
      ownerUserId: context.agent.ownerUserId ?? null,
      visibility: (context.agent.visibility === 'private' ? 'private' : 'team') as
        'private' | 'team',
    },
    cloudBrowser: deps.cloudBrowser,
    consumedSources: context.consumedSources,
    documentStream: deps.documentStream,
    executorCommandEncryptionSecret: deps.executorCommandEncryptionSecret,
    // The same deployment secret; named separately so its one purpose is
    // legible at the call sites that use it.
    boardSourceEncryptionSecret: deps.executorCommandEncryptionSecret,
    ledgerIdentity: deps.ledgerIdentity ?? null,
    mcpSecrets: deps.mcpSecrets,
    memoryCaptureConfig: {
      modelClient: deps.modelClient,
      pool: deps.searchConfig.pool,
    },
    modelClient: deps.modelClient,
    prisma: deps.prisma,
    realtimeTransport: deps.realtimeTransport,
    run: {
      id: context.run.id,
      browserHandback: payload.browserHandback ?? null,
      interactive: payload.interactive === true,
      messageId: payload.messageId,
      principalUserId: context.run.principalUserId,
      originatingUserId:
        toolActorContext.actionContext.effectiveUserId
        ?? (
          toolActorContext.actor.actorType === 'user'
            ? toolActorContext.actor.actorId
            : null
        ),
      threadId: context.run.threadId,
    },
    runContext: context,
    toolCallId,
  })

  const execute = (
    toolName: string,
    args: Record<string, unknown>,
    toolActorContext: ToolActorContext,
    toolCallId: string,
    authorization?: GmailSendAuthorization,
  ) =>
    executeBuiltinTool(
      toolName,
      args,
      buildContext(toolActorContext, toolCallId, authorization),
      stubbedBuiltinToolIds,
    )

  return {
    execute,
    executeAuthorized: (
      toolName: string,
      args: Record<string, unknown>,
      toolCallId: string,
      authorization: Extract<ToolAuthorizationDecision, { decision: 'allow' }>,
    ) =>
      execute(toolName, args, authorization.toolActorContext, toolCallId, {
        gmailDraftSendApproved: authorization.gmailDraftSendApproved,
        gmailDraftSendStandingAuthorized: authorization.gmailDraftSendStandingAuthorized,
      }),
  }
}

/** Keeps approval suspension formatting beside the runtime authorization path. */
export const buildApprovalSuspensionResult = (
  args: Record<string, unknown>,
  authorization: Extract<ToolAuthorizationDecision, { decision: 'suspend' }>,
) => ({
  inputSummary: summarizeToolInput(args),
  output: 'Tool execution is waiting for human approval.',
  pendingApproval: {
    approvalId: authorization.approval.id,
    notice: authorization.approval.notice,
    toolName: authorization.approval.toolName,
  },
  success: false,
})
