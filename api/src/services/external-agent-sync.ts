import { Prisma, type PrismaClient } from '@prisma/client'
import {
  callInstanceTool,
  mapChatResultToUiCards,
  type SecretResolver,
} from '@nessie/mcp-manage'
import {
  DEEPSIGNAL_MCP_CREDENTIAL_REF,
  type DeepSignalMcpIdentityService,
  type LedgerAttribution,
} from '@nessie/runtime'
import type { IntegrationUiCard, McpTransportConfig } from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'
import { callDeepSignalMcpTool } from './deepsignal-mcp-call.js'
import { getExternalAgentProduct } from './external-agent.js'
import { resolveUserScopedProductTransport } from './external-agent-instance.js'
import { asArray, extractList, firstString, isRecord, readToolJson } from './mcp-tool-json.js'

/**
 * External-agent history hydration (DeepSignal integration plan §6).
 *
 * DeepSignal owns the conversation. On channel open the API pulls the thread's
 * conversation history over MCP and upserts any turns Nessie has not seen —
 * including turns the user made on the DeepSignal console or mobile. Idempotency
 * key is `Message.metadata.external.turnId`; live Nessie-originated turns are
 * already persisted by the worker driver under the same key and are skipped.
 *
 * No inference runs here — Nessie proxies and mirrors, it never re-interprets.
 */

const CONVERSATION_LIST_TOOL = 'conversation_list'
const CONVERSATION_HISTORY_TOOL = 'conversation_history'
const HISTORY_LIMIT = 50

export const EXTERNAL_AGENT_SYNC_ERROR_CODES = {
  NOT_EXTERNAL_AGENT: 'EXTERNAL_AGENT_SYNC_NOT_EXTERNAL_AGENT',
  UNKNOWN_PRODUCT: 'EXTERNAL_AGENT_SYNC_UNKNOWN_PRODUCT',
  IDENTITY_UNAVAILABLE: 'EXTERNAL_AGENT_SYNC_IDENTITY_UNAVAILABLE',
  UPSTREAM_UNAVAILABLE: 'EXTERNAL_AGENT_SYNC_UPSTREAM_UNAVAILABLE',
} as const

export type ExternalAgentSyncErrorCode =
  (typeof EXTERNAL_AGENT_SYNC_ERROR_CODES)[keyof typeof EXTERNAL_AGENT_SYNC_ERROR_CODES]

export class ExternalAgentSyncError extends Error {
  constructor(
    readonly code: ExternalAgentSyncErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExternalAgentSyncError'
  }
}

export type ExternalAgentSyncResult = { imported: number; total: number }

type HistoryTurn = {
  id: string
  role: 'user' | 'colleague'
  content: string
  activities: unknown[]
  cards: unknown[]
  createdAt: Date | null
}

const parseTurn = (raw: unknown): HistoryTurn | null => {
  if (!isRecord(raw)) return null
  const id = firstString(raw, ['id', 'turnId', 'turn_id'])
  if (!id) return null
  const role = raw.role === 'colleague' || raw.role === 'assistant' ? 'colleague' : 'user'
  const content =
    role === 'colleague'
      ? firstString(raw, ['reply', 'message', 'text', 'output'])
      : firstString(raw, ['input', 'message', 'text'])
  const createdRaw = firstString(raw, ['createdAt', 'created_at'])
  const createdAt = createdRaw ? new Date(createdRaw) : null
  return {
    id,
    role,
    content: content ?? '',
    activities: asArray(raw.activities),
    cards: asArray(raw.cards),
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
  }
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
  prisma: PrismaClient,
  threadId: string,
  metadata: unknown,
  slug: string,
  conversationId: string,
): Promise<void> => {
  const base = isRecord(metadata) ? metadata : {}
  const bag = isRecord(base[slug]) ? (base[slug] as Record<string, unknown>) : {}
  await prisma.thread.update({
    where: { id: threadId },
    data: {
      metadata: { ...base, [slug]: { ...bag, conversationId } } as Prisma.InputJsonValue,
    },
  })
}

export type ExternalAgentSyncContext = {
  attribution: LedgerAttribution
  deepSignalIdentity: DeepSignalMcpIdentityService | null
  organizationId: string
  userId: string
  /** MCP tool caller seam (defaults to the shared one-shot dispatcher). */
  callTool?: typeof callInstanceTool
}

type ResolvedChannel = {
  channelId: string
  slug: string
  transport: McpTransportConfig
  threadId: string
  threadMetadata: unknown
  agentId: string | null
}

/**
 * Resolve the product slug + user instance transport + default thread for a
 * verified external-agent channel. The caller has already confirmed the channel
 * type + membership. Returns null when the connector is not installed for this
 * user yet (nothing to import — sync is a no-op, not an error).
 */
const resolveChannel = async (
  prisma: PrismaClient,
  ctx: ExternalAgentSyncContext,
  channel: { id: string; dmKey: string | null },
  secretResolver: SecretResolver,
): Promise<ResolvedChannel | null> => {
  const parts = (channel.dmKey ?? '').split(':')
  const slug = parts[0] === 'extagent' && parts[1] ? parts[1] : null
  if (!slug || !getExternalAgentProduct(slug)) {
    throw new ExternalAgentSyncError(
      EXTERNAL_AGENT_SYNC_ERROR_CODES.UNKNOWN_PRODUCT,
      'This channel is not linked to a known external-agent product',
    )
  }

  const transport = await resolveUserScopedProductTransport(
    prisma,
    {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      slug,
      channelId: channel.id,
      ...(slug === 'deepsignal'
        ? { managedCredentialRef: DEEPSIGNAL_MCP_CREDENTIAL_REF }
        : {}),
    },
    secretResolver,
  )
  if (!transport) return null

  const threadId = await ensureDefaultThread(prisma, channel.id)
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { metadata: true },
  })
  const binding = await prisma.agentBinding.findFirst({
    where: { channelId: channel.id },
    select: { agentId: true },
  })

  return {
    channelId: channel.id,
    slug,
    transport,
    threadId,
    threadMetadata: thread?.metadata ?? null,
    agentId: binding?.agentId ?? null,
  }
}

type ResolvedToolCaller = (
  toolName: string,
  args: unknown,
) => ReturnType<typeof callInstanceTool>

const resolvedToolCaller = (
  resolved: ResolvedChannel,
  ctx: ExternalAgentSyncContext,
): ResolvedToolCaller => {
  if (resolved.slug !== 'deepsignal') {
    const callTool = ctx.callTool ?? callInstanceTool
    return (toolName, args) =>
      callTool({ transport: resolved.transport, toolName, args })
  }
  if (!ctx.deepSignalIdentity) {
    throw new ExternalAgentSyncError(
      EXTERNAL_AGENT_SYNC_ERROR_CODES.IDENTITY_UNAVAILABLE,
      'DeepSignal application identity is not configured.',
    )
  }
  const identityService = ctx.deepSignalIdentity
  const attribution: LedgerAttribution = {
    ...ctx.attribution,
    agentId: resolved.agentId,
    channelId: resolved.channelId,
    threadId: resolved.threadId,
    systemComponent: 'api-deepsignal-history-sync',
  }
  return (toolName, args) =>
    callDeepSignalMcpTool(
      resolved.transport,
      {
        attribution,
        identityService,
        callTool: ctx.callTool,
      },
      toolName,
      args,
    )
}

/** Call `conversation_list` and return the most recent conversation id, or null. */
const adoptLatestConversation = async (
  callTool: ResolvedToolCaller,
): Promise<string | null> => {
  const result = await callTool(CONVERSATION_LIST_TOOL, {})
  const conversations = extractList(readToolJson(result), ['conversations', 'items', 'data'])
  let best: { id: string; at: number } | null = null
  for (const raw of conversations) {
    if (!isRecord(raw)) continue
    const id = firstString(raw, ['id', 'conversationId', 'conversation_id'])
    if (!id) continue
    const atRaw = firstString(raw, ['updatedAt', 'updated_at', 'createdAt', 'created_at'])
    const at = atRaw ? new Date(atRaw).getTime() : 0
    if (!best || at >= best.at) best = { id, at: Number.isNaN(at) ? 0 : at }
  }
  return best?.id ?? null
}

const upsertTurns = async (
  prisma: PrismaClient,
  resolved: ResolvedChannel,
  ctx: ExternalAgentSyncContext,
  conversationId: string,
  turns: HistoryTurn[],
): Promise<number> => {
  // Existing external turns already mirrored into this thread (idempotency set).
  const prior = await prisma.message.findMany({
    where: { threadId: resolved.threadId, metadata: { path: ['external', 'product'], equals: resolved.slug } },
    select: { metadata: true },
  })
  const seen = new Set<string>()
  for (const row of prior) {
    const meta = row.metadata
    if (isRecord(meta) && isRecord(meta.external)) {
      const turnId = meta.external.turnId
      if (typeof turnId === 'string') seen.add(turnId)
    }
  }

  // Oldest-first so the mirrored timeline reads chronologically.
  const ordered = [...turns]
    .filter((turn) => !seen.has(turn.id))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))

  let imported = 0
  for (const turn of ordered) {
    const external = { product: resolved.slug, conversationId, turnId: turn.id }
    if (turn.role === 'colleague') {
      const uiCards: IntegrationUiCard[] = mapChatResultToUiCards(resolved.slug, {
        activities: turn.activities,
        cards: turn.cards,
      })
      await prisma.message.create({
        data: {
          agentId: resolved.agentId,
          threadId: resolved.threadId,
          role: 'assistant',
          content: turn.content.length > 0 ? turn.content : '(no reply)',
          metadata: { uiCards, external } as Prisma.InputJsonValue,
          ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
        },
      })
    } else {
      await prisma.message.create({
        data: {
          userId: ctx.userId,
          threadId: resolved.threadId,
          role: 'user',
          content: turn.content.length > 0 ? turn.content : '(no message)',
          metadata: { external } as Prisma.InputJsonValue,
          ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
        },
      })
    }
    imported += 1
  }
  return imported
}

/**
 * Hydrate a verified external-agent channel's default thread from DeepSignal.
 * The caller MUST have already checked channel type + membership. Returns the
 * count imported this run and the total turns DeepSignal reported.
 */
export const syncExternalAgentChannel = async (
  prisma: PrismaClient,
  channel: { id: string; dmKey: string | null },
  ctx: ExternalAgentSyncContext,
  secretResolver: SecretResolver,
): Promise<ExternalAgentSyncResult> => {
  const resolved = await resolveChannel(prisma, ctx, channel, secretResolver)
  if (!resolved) return { imported: 0, total: 0 }

  try {
    const callTool = resolvedToolCaller(resolved, ctx)
    let conversationId = readConversationId(resolved.threadMetadata, resolved.slug)
    if (!conversationId) {
      // The user may have chatted on the DeepSignal console before ever opening
      // the Nessie channel — adopt their most recent conversation.
      conversationId = await adoptLatestConversation(callTool)
      if (!conversationId) return { imported: 0, total: 0 }
      await writeConversationId(
        prisma,
        resolved.threadId,
        resolved.threadMetadata,
        resolved.slug,
        conversationId,
      ).catch(() => undefined)
    }

    const result = await callTool(
      CONVERSATION_HISTORY_TOOL,
      { conversationId, limit: HISTORY_LIMIT },
    )
    const rawTurns = extractList(readToolJson(result), ['turns', 'history', 'items', 'messages'])
    const turns = rawTurns.flatMap((raw) => {
      const turn = parseTurn(raw)
      return turn ? [turn] : []
    })

    const imported = await upsertTurns(prisma, resolved, ctx, conversationId, turns)
    return { imported, total: turns.length }
  } catch (error) {
    if (error instanceof ExternalAgentSyncError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ExternalAgentSyncError(
      EXTERNAL_AGENT_SYNC_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      `Could not reach the external agent to sync history: ${message.slice(0, 200)}`,
    )
  }
}
