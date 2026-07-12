import type { PrismaClient } from '@prisma/client'
import { callInstanceTool, type SecretResolver } from '@nessie/mcp-manage'
import type {
  DeepSignalSignalAction,
  DeepSignalSignalActResponse,
  DeepSignalSignalKind,
  DeepSignalSignalRecord,
  DeepSignalSignalsResponse,
  DeepSignalSignalStatus,
} from '@nessie/schemas'

import { resolveUserScopedProductTransport } from './external-agent-instance.js'
import { asArray, extractList, firstString, isRecord, readToolJson } from './mcp-tool-json.js'

/**
 * DeepSignal Signals surface (surface-registry plan §4).
 *
 * Reads the user's insight digest and proxies done/snooze/mute/reopen actions
 * over the user's own user-scoped DeepSignal MCP instance — no Nessie inference,
 * no fabrication. Tenancy comes strictly from the authenticated principal; the
 * insight id is the only argument the caller supplies. When the connector is not
 * installed / signed in for the user the result is `needs_setup`, which the page
 * renders as a "Connect DeepSignal" empty state.
 */

const DEEPSIGNAL_SLUG = 'deepsignal'
const DIGEST_TOOL = 'insight_digest'
const ACT_TOOL = 'insight_act'

export type DeepSignalSignalsContext = {
  organizationId: string
  userId: string
  /** MCP tool caller seam (defaults to the shared one-shot dispatcher). */
  callTool?: typeof callInstanceTool
}

/** Which insights to include; `active` (default) hides done/snoozed/muted. */
export type DeepSignalDigestInclude = 'active' | 'all'

const parseStatus = (raw: Record<string, unknown>): DeepSignalSignalStatus => {
  const value = (firstString(raw, ['status', 'state']) ?? 'active').toLowerCase()
  if (['done', 'completed', 'resolved', 'acknowledged'].includes(value)) return 'done'
  if (['snoozed', 'snooze', 'deferred'].includes(value)) return 'snoozed'
  if (['muted', 'mute', 'dismissed', 'ignored'].includes(value)) return 'muted'
  return 'active'
}

const parseKind = (raw: Record<string, unknown>): DeepSignalSignalKind | null => {
  const value = (firstString(raw, ['kind', 'type', 'category']) ?? '').toLowerCase()
  if (['opportunity', 'opportunities'].includes(value)) return 'opportunity'
  if (['risk', 'risks', 'threat'].includes(value)) return 'risk'
  if (value === 'signal') return 'signal'
  return null
}

const parseActionIds = (raw: Record<string, unknown>): string[] => {
  const source = raw.actions ?? raw.actionIds ?? raw.action_ids
  const ids: string[] = []
  for (const entry of asArray(source)) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      ids.push(entry)
    } else if (isRecord(entry)) {
      const id = firstString(entry, ['id', 'actionId', 'action_id', 'action'])
      if (id) ids.push(id)
    }
  }
  return ids
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const parseTimestamp = (raw: Record<string, unknown>): string | null => {
  const value = firstString(raw, ['surfacedAt', 'surfaced_at', 'createdAt', 'created_at', 'updatedAt', 'updated_at'])
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** Coerce one raw insight into a typed record, dropping anything unusable. */
export const parseSignal = (raw: unknown): DeepSignalSignalRecord | null => {
  if (!isRecord(raw)) return null
  const id = firstString(raw, ['id', 'insightId', 'insight_id'])
  const headline = firstString(raw, ['headline', 'title', 'name', 'summary'])
  if (!id || !headline) return null
  const summary =
    firstString(raw, ['whyItMatters', 'why_it_matters', 'summary', 'description', 'body', 'detail']) ?? ''
  const deepLinkRaw = firstString(raw, ['deepLink', 'deep_link', 'url', 'href', 'link'])
  return {
    id,
    headline,
    summary: summary === headline ? '' : summary,
    status: parseStatus(raw),
    kind: parseKind(raw),
    actionIds: parseActionIds(raw),
    deepLink: deepLinkRaw && isHttpUrl(deepLinkRaw) ? deepLinkRaw : null,
    surfacedAt: parseTimestamp(raw),
  }
}

const parseSignals = (payload: unknown): DeepSignalSignalRecord[] => {
  const list = extractList(payload, ['insights', 'items', 'signals', 'digest', 'data'])
  return list.flatMap((raw) => {
    const signal = parseSignal(raw)
    return signal ? [signal] : []
  })
}

/**
 * Read the user's insight digest. Returns `needs_setup` (fail-closed) when the
 * DeepSignal connector is not resolvable for this user.
 */
export const listDeepSignalSignals = async (
  prisma: PrismaClient,
  ctx: DeepSignalSignalsContext,
  secretResolver: SecretResolver,
  include: DeepSignalDigestInclude = 'active',
): Promise<DeepSignalSignalsResponse> => {
  const callTool = ctx.callTool ?? callInstanceTool
  const transport = await resolveUserScopedProductTransport(
    prisma,
    { organizationId: ctx.organizationId, userId: ctx.userId, slug: DEEPSIGNAL_SLUG },
    secretResolver,
  )
  if (!transport) return { status: 'needs_setup' }

  const result = await callTool({ transport, toolName: DIGEST_TOOL, args: { include } })
  return { status: 'ok', items: parseSignals(readToolJson(result)) }
}

/**
 * Proxy a done/snooze/mute/reopen action for one insight back to DeepSignal.
 * Returns the updated record when the tool echoes one, else `item: null`.
 */
export const actOnDeepSignalSignal = async (
  prisma: PrismaClient,
  ctx: DeepSignalSignalsContext,
  secretResolver: SecretResolver,
  insightId: string,
  action: DeepSignalSignalAction,
): Promise<DeepSignalSignalActResponse> => {
  const callTool = ctx.callTool ?? callInstanceTool
  const transport = await resolveUserScopedProductTransport(
    prisma,
    { organizationId: ctx.organizationId, userId: ctx.userId, slug: DEEPSIGNAL_SLUG },
    secretResolver,
  )
  if (!transport) return { status: 'needs_setup' }

  const result = await callTool({
    transport,
    toolName: ACT_TOOL,
    args: { insightId, action },
  })
  const payload = readToolJson(result)
  const item = parseSignal(isRecord(payload) ? (payload.insight ?? payload) : payload)
  return { status: 'ok', item }
}
