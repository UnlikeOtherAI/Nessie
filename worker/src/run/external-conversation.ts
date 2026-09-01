import { Prisma } from '@prisma/client'
import {
  EnvSecretResolver,
  applyMcpRequestIdentity,
  failedCard,
  mapChatResultToUiCards,
  needsSetupCard,
  mcpTransportAudience,
  parseChatToolResult,
  type SecretResolver,
} from '@nessie/mcp-manage'
import {
  attributionFromActorContext,
  recordConnectorUsage,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseRunId,
  parseThreadId,
  type IntegrationUiCard,
  type McpTransportConfig,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { dispatchTool, type ToolDispatchResult } from './tool-dispatch.js'
import {
  tagInboundUserMessage,
  withThreadLock,
  writeConversationId,
} from './external-conversation-store.js'
import {
  resolveExternalConversationTarget,
  type ExternalTarget,
} from './external-conversation-target.js'
import {
  claimRunForExecution,
  setAgentStatus,
  updateRunStatus,
  updateTaskStatus,
} from './execute/lifecycle.js'
import { validateRunActorContext } from './execute/policy.js'
import {
  publishAgentStatus,
  publishMessageCreated,
  publishRunUpdated,
  publishTaskUpdated,
} from './execute/realtime.js'
import { enqueueInteractiveReplyPush } from './execute/reply-push.js'
import { buildScopes } from './execute/scopes.js'
import type { ExecutionDependencies, RunContext } from './execute/types.js'

/**
 * External-conversation driver (DeepSignal integration plan §5).
 *
 * When a channel's bound agent has `executionMode = external_mcp`, the turn is
 * proxied directly to the external product over MCP — Nessie runs NO inference,
 * spends no model tokens, and never re-interprets the reply. This module owns
 * the full run lifecycle for those turns (claim → dispatch → persist → terminal
 * state) so `run-job` can branch to it and return. There is no fallback to the
 * inference path: every outcome ends the run in a terminal state.
 */

const CHAT_TOOL_NAME = 'chat'
const DEEPSIGNAL_SLUG = 'deepsignal'

/** MCP tool caller seam — injected in tests, defaults to the shared dispatcher. */
export type ExternalChatCaller = (input: {
  transport: McpTransportConfig
  args: Record<string, unknown>
}) => Promise<ToolDispatchResult>

export type ExternalConversationOptions = {
  callChat?: ExternalChatCaller
  secretResolver?: SecretResolver
}

const defaultSecretResolver = new EnvSecretResolver()

const defaultCallChat: ExternalChatCaller = (input) =>
  dispatchTool({
    spec: { transport: 'mcp', connection: input.transport, toolName: CHAT_TOOL_NAME },
    args: input.args,
    // Auth headers are already baked into `transport` by the catalog authConfig;
    // pass no bearer here (mirrors how the toolset dispatches).
    secret: null,
  })

const AUTH_ERROR_PATTERN =
  /\b(401|403)\b|unauthor|forbidden|invalid[_ ]?token|token.{0,12}expired|not.{0,4}authenticated/i

const looksLikeAuthError = (text: string): boolean => AUTH_ERROR_PATTERN.test(text)

type ExternalTurnOutcome = {
  content: string
  uiCards: IntegrationUiCard[]
  external?: { product: string; conversationId: string | null; turnId: string | null }
  runStatus: 'completed' | 'failed'
  agentStatus: 'idle' | 'error'
}

const dispatchTurn = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  target: ExternalTarget,
  prompt: string,
  callChat: ExternalChatCaller,
): Promise<ExternalTurnOutcome> => {
  const args: Record<string, unknown> = { input: prompt }
  if (target.conversationId) {
    args.conversationId = target.conversationId
  }

  const attribution = attributionFromActorContext(payload.actorContext, {
    agentId: context.agent.id,
    runId: context.run.id,
  })
  const startedAt = Date.now()

  const recordUsage = (success: boolean): Promise<void> =>
    recordConnectorUsage(deps.prisma, {
      attribution,
      event: {
        connectorType: 'mcp',
        connectorId: target.instanceId,
        target: CHAT_TOOL_NAME,
        operation: CHAT_TOOL_NAME,
        success,
        latencyMs: Date.now() - startedAt,
      },
    }).catch(() => {
      // Best-effort operational usage capture.
    })

  let result: ToolDispatchResult
  try {
    let transport = target.transport
    if (target.slug === DEEPSIGNAL_SLUG) {
      if (!deps.deepSignalMcpIdentity) {
        throw new Error('DeepSignal application identity is not configured.')
      }
      const identityHeaders = await deps.deepSignalMcpIdentity.requestHeaders(
        attribution,
        {
          audience: mcpTransportAudience(transport),
          toolCallId: `${context.run.id}:${CHAT_TOOL_NAME}`,
        },
      )
      transport = applyMcpRequestIdentity(transport, identityHeaders)
    }
    result = await callChat({ transport, args })
  } catch (error) {
    await recordUsage(false)
    const message = error instanceof Error ? error.message : String(error)
    if (looksLikeAuthError(message)) {
      if (target.slug === DEEPSIGNAL_SLUG) {
        return {
          content: `${target.label} rejected Nessie's application credential.`,
          uiCards: [
            failedCard(
              target.slug,
              target.label,
              'The product application key must be repaired by an administrator.',
            ),
          ],
          runStatus: 'failed',
          agentStatus: 'error',
        }
      }
      return {
        content: `Your ${target.label} sign-in has expired. Reconnect ${target.label} to continue.`,
        uiCards: [needsSetupCard(target.slug, target.label, 'Reconnect to refresh your access.')],
        runStatus: 'completed',
        agentStatus: 'idle',
      }
    }
    return {
      content: `I couldn't reach ${target.label} just now.`,
      uiCards: [failedCard(target.slug, target.label, message.slice(0, 300))],
      runStatus: 'failed',
      agentStatus: 'error',
    }
  }

  await recordUsage(result.success)

  if (!result.success) {
    if (looksLikeAuthError(result.output)) {
      if (target.slug === DEEPSIGNAL_SLUG) {
        return {
          content: `${target.label} rejected Nessie's application credential.`,
          uiCards: [
            failedCard(
              target.slug,
              target.label,
              'The product application key must be repaired by an administrator.',
            ),
          ],
          runStatus: 'failed',
          agentStatus: 'error',
        }
      }
      return {
        content: `Your ${target.label} sign-in has expired. Reconnect ${target.label} to continue.`,
        uiCards: [needsSetupCard(target.slug, target.label, 'Reconnect to refresh your access.')],
        runStatus: 'completed',
        agentStatus: 'idle',
      }
    }
    return {
      content: `${target.label} returned an error for this request.`,
      uiCards: [failedCard(target.slug, target.label, result.output.slice(0, 300))],
      runStatus: 'failed',
      agentStatus: 'error',
    }
  }

  const parsed = parseChatToolResult(result.output)
  if (parsed.conversationId) {
    await writeConversationId(
      deps,
      context.run.threadId,
      target.threadMetadata,
      target.slug,
      parsed.conversationId,
    ).catch(() => {
      // Losing the conversationId only costs continuity, never the reply.
    })
  }

  if (parsed.userTurnId) {
    await tagInboundUserMessage(deps, payload.messageId, {
      product: target.slug,
      conversationId: parsed.conversationId,
      turnId: parsed.userTurnId,
    }).catch(() => {
      // Best-effort: a missed tag only risks a one-time re-import on reopen.
    })
  }

  return {
    content: parsed.reply.trim().length > 0 ? parsed.reply : `(${target.label} returned no reply.)`,
    uiCards: mapChatResultToUiCards(target.slug, parsed),
    external: {
      product: target.slug,
      conversationId: parsed.conversationId,
      turnId: parsed.turnId,
    },
    runStatus: 'completed',
    agentStatus: 'idle',
  }
}

const finalizeTurn = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  outcome: ExternalTurnOutcome,
  onMessageCreated?: () => void,
): Promise<void> => {
  const metadata: Record<string, unknown> = { uiCards: outcome.uiCards }
  if (outcome.external) {
    metadata.external = outcome.external
  }

  const message = await deps.prisma.message.create({
    data: {
      agentId: context.agent.id,
      content: outcome.content,
      metadata: metadata as Prisma.InputJsonValue,
      role: 'assistant',
      threadId: context.run.threadId,
    },
  })
  // From this point onward an outer error handler must repair terminal state,
  // not write a second fallback message. The run-scoped push idempotency key
  // is a second guard against duplicate delivery during that repair.
  onMessageCreated?.()
  // Queue as soon as the reply is durable. Realtime and lifecycle effects may
  // still fail afterwards; a notification must not be lost because the outer
  // repair deliberately avoids writing a duplicate fallback message.
  await enqueueInteractiveReplyPush(deps, payload, context, message)

  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: outcome.content,
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    runId: parseRunId(context.run.id),
  })
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: outcome.content,
    messageId: message.id,
    role: 'assistant',
  })
  await updateRunStatus(deps.prisma, context.run.id, outcome.runStatus)
  await updateTaskStatus(deps.prisma, context.task.id, outcome.runStatus === 'completed' ? 'done' : 'failed')
  await setAgentStatus(deps.prisma, context.agent.id, outcome.agentStatus)
  await publishRunUpdated(deps.realtimeTransport, context, outcome.runStatus)
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    outcome.runStatus === 'completed' ? 'done' : 'failed',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: outcome.agentStatus,
  })
}

/**
 * Drive one external-conversation turn end-to-end. Never throws for expected
 * failure modes (missing connector, expired auth, unreachable service): each
 * ends the run in a terminal state with an honest in-channel card. An
 * unexpected error is caught by the outer guard and marks the run failed — there
 * is no path back to Nessie inference.
 */
export const runExternalConversation = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  prompt: string,
  options: ExternalConversationOptions = {},
): Promise<void> => {
  const claimed = await claimRunForExecution(deps.prisma, context.run.id)
  if (!claimed) {
    return
  }

  const secretResolver = options.secretResolver ?? deps.mcpSecrets?.resolver ?? defaultSecretResolver
  const callChat = options.callChat ?? defaultCallChat
  let terminalMessageCreated = false
  const finalize = (outcome: ExternalTurnOutcome): Promise<void> =>
    finalizeTurn(deps, payload, context, outcome, () => {
      terminalMessageCreated = true
    })

  try {
    await updateTaskStatus(deps.prisma, context.task.id, 'in_progress')
    await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
    await publishRunUpdated(deps.realtimeTransport, context, 'running')
    await publishTaskUpdated(deps.realtimeTransport, buildScopes(context), context.task.id, 'in_progress')
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'thinking',
    })
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      agentId: parseAgentId(context.agent.id),
      // External-agent turns are always top-level: their message flow is
      // proxied verbatim and never threads under the trigger.
      rootMessageId: null,
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })

    // Emit `stream.start` first so a validation failure still balances with the
    // `stream.done` the catch path finalizes.
    await validateRunActorContext(deps.prisma, payload.actorContext, context)

    // Serialize per thread so a concurrent first turn's conversationId write is
    // observed here rather than each turn minting a fresh DeepSignal conversation.
    await withThreadLock(context.run.threadId, async () => {
      const resolution = await resolveExternalConversationTarget(
        deps,
        payload,
        context,
        secretResolver,
      )
      if (!resolution) {
        // Not actually an external-agent channel — end the run cleanly rather than
        // silently doing nothing (the branch should never be taken, but be safe).
        await finalize({
          content: 'This conversation is not connected to an external agent.',
          uiCards: [],
          runStatus: 'failed',
          agentStatus: 'error',
        })
        return
      }

      if (resolution.kind === 'needs_setup') {
        await finalize({
          content: resolution.summary,
          uiCards: [needsSetupCard(resolution.slug, resolution.label, resolution.summary)],
          runStatus: 'completed',
          agentStatus: 'idle',
        })
        return
      }

      const outcome = await dispatchTurn(
        deps,
        payload,
        context,
        resolution.target,
        prompt,
        callChat,
      )
      await finalize(outcome)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[worker] external conversation run ${context.run.id} failed`, message)
    if (terminalMessageCreated) {
      // `finalize` persisted the reply before a later realtime/status side
      // effect failed. Do not turn that one reply into a second in-channel
      // error; repair the durable terminal run state instead.
      await updateRunStatus(deps.prisma, context.run.id, 'failed').catch(() => undefined)
      return
    }
    // Terminal failure without rethrow: no retry loop, no inference fallback.
    await finalize({
      content: 'I hit an unexpected error handling this request.',
      uiCards: [],
      runStatus: 'failed',
      agentStatus: 'error',
    }).catch(() => {
      // If even finalize fails, fall back to a bare terminal status write.
      return updateRunStatus(deps.prisma, context.run.id, 'failed').catch(() => undefined)
    })
  }
}
