import { Prisma } from '@prisma/client'
import { EnvSecretResolver, type SecretResolver } from '@nessie/mcp-manage'
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

import { resolveInstanceMcpTransport } from './mcp-instance-call.js'
import { dispatchTool, type ToolDispatchResult } from './tool-dispatch.js'
import {
  failedCard,
  mapChatResultToUiCards,
  needsSetupCard,
  parseChatToolResult,
} from './external-conversation-cards.js'
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

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

const effectiveUserIdOf = (payload: RunExecuteJobPayload): string | null =>
  payload.actorContext.actionContext.effectiveUserId
  ?? (payload.actorContext.actor.actorType === 'user'
    ? payload.actorContext.actor.actorId
    : null)

/** dmKey shape: `extagent:<slug>:<orgId>:<userId>`. */
const productSlugFromDmKey = (dmKey: string | null): string | null => {
  if (!dmKey) return null
  const parts = dmKey.split(':')
  return parts[0] === 'extagent' && parts[1] ? parts[1] : null
}

const readConversationId = (metadata: unknown, slug: string): string | null => {
  if (!isRecord(metadata)) return null
  const bag = metadata[slug]
  if (isRecord(bag) && typeof bag.conversationId === 'string' && bag.conversationId.length > 0) {
    return bag.conversationId
  }
  return null
}

const writeConversationId = async (
  deps: ExecutionDependencies,
  threadId: string,
  metadata: unknown,
  slug: string,
  conversationId: string,
): Promise<void> => {
  const base = isRecord(metadata) ? metadata : {}
  const bag = isRecord(base[slug]) ? (base[slug] as Record<string, unknown>) : {}
  await deps.prisma.thread.update({
    where: { id: threadId },
    data: {
      metadata: { ...base, [slug]: { ...bag, conversationId } } as Prisma.InputJsonValue,
    },
  })
}

type ExternalTarget = {
  slug: string
  label: string
  instanceId: string
  transport: McpTransportConfig
  conversationId: string | null
  threadMetadata: unknown
}

type TargetResolution =
  | { kind: 'ready'; target: ExternalTarget }
  | { kind: 'needs_setup'; slug: string; label: string; summary: string }

const resolveTarget = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  secretResolver: SecretResolver,
): Promise<TargetResolution | null> => {
  const channel = await deps.prisma.channel.findUnique({
    where: { id: context.channel.id },
    select: { dmKey: true, label: true },
  })
  const slug = productSlugFromDmKey(channel?.dmKey ?? null)
  if (!slug) {
    return null
  }
  const label = channel?.label?.trim() || slug
  const userId = effectiveUserIdOf(payload)
  if (!userId) {
    return { kind: 'needs_setup', slug, label, summary: 'No signed-in user for this conversation.' }
  }

  const instance = await deps.prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: context.channel.organizationId,
      scopeType: 'user',
      scopeId: userId,
      catalogEntry: { name: slug, visibility: 'public' },
    },
    select: { id: true },
  })
  if (!instance) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected for your account yet. Activate it to start chatting.`,
    }
  }

  const resolved = await resolveInstanceMcpTransport(
    deps.prisma,
    instance.id,
    {
      userId,
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
    },
    secretResolver,
  )
  if (!resolved) {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `${label} is not connected for your account yet. Activate it to start chatting.`,
    }
  }
  if (resolved.authMethod === 'oauth2' && resolved.lifecycleState !== 'active') {
    return {
      kind: 'needs_setup',
      slug,
      label,
      summary: `Sign in to ${label} to finish connecting your account.`,
    }
  }

  const thread = await deps.prisma.thread.findUnique({
    where: { id: context.run.threadId },
    select: { metadata: true },
  })

  return {
    kind: 'ready',
    target: {
      slug,
      label,
      instanceId: instance.id,
      transport: resolved.transport,
      conversationId: readConversationId(thread?.metadata, slug),
      threadMetadata: thread?.metadata ?? null,
    },
  }
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
      // best-effort billing capture
    })

  let result: ToolDispatchResult
  try {
    result = await callChat({ transport: target.transport, args })
  } catch (error) {
    await recordUsage(false)
    const message = error instanceof Error ? error.message : String(error)
    if (looksLikeAuthError(message)) {
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
  context: RunContext,
  outcome: ExternalTurnOutcome,
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

  try {
    await validateRunActorContext(deps.prisma, payload.actorContext, context)

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
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })

    const resolution = await resolveTarget(deps, payload, context, secretResolver)
    if (!resolution) {
      // Not actually an external-agent channel — end the run cleanly rather than
      // silently doing nothing (the branch should never be taken, but be safe).
      await finalizeTurn(deps, context, {
        content: 'This conversation is not connected to an external agent.',
        uiCards: [],
        runStatus: 'failed',
        agentStatus: 'error',
      })
      return
    }

    if (resolution.kind === 'needs_setup') {
      await finalizeTurn(deps, context, {
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
    await finalizeTurn(deps, context, outcome)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[worker] external conversation run ${context.run.id} failed`, message)
    // Terminal failure without rethrow: no retry loop, no inference fallback.
    await finalizeTurn(deps, context, {
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
