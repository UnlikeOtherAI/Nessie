import {
  IntegrationUiCardSchema,
  type IntegrationUiCard,
  type IntegrationUiCardStatus,
} from '@nessie/schemas'

/**
 * Translation layer between an external product's `chat` tool result and
 * Nessie's in-channel rendering surface (`Message.metadata.uiCards`).
 *
 * DeepSignal returns JSON text content shaped
 * `{ conversationId, userTurnId?, turnId, reply, activities[], cards[] }`.
 * `activities` are typed tool/skill events; `cards` are generative UI specs.
 * Both are mapped onto `IntegrationUiCardSchema` so the existing `MessageUiCards`
 * component renders them with no product-specific code. `turnId` is the
 * colleague (assistant) turn id; `userTurnId` is the id DeepSignal assigned to
 * the user turn that drove this exchange — the worker driver tags the inbound
 * user message with it so history re-hydration dedupes both roles (plan §6).
 * Everything here is defensive: a plain-text tool result degrades to a bare
 * reply with no cards, `userTurnId` is optional (older DeepSignal omits it), and
 * any card that fails schema validation is dropped rather than corrupting the
 * message.
 */

export type ExternalChatResult = {
  reply: string
  conversationId: string | null
  userTurnId: string | null
  turnId: string | null
  activities: unknown[]
  cards: unknown[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const firstString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return null
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Pull the structured chat payload out of whatever the MCP dispatcher handed
 * back. The dispatcher stringifies `structuredContent` when present, else the
 * content-block array; a well-behaved server may also return the object
 * directly. We try, in order: the object as-is, a JSON parse, and the text of
 * any content blocks — falling back to the raw string as a plain reply.
 */
const coerceChatPayload = (output: string): Record<string, unknown> | string => {
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    return ''
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed
  }
  if (isRecord(parsed)) {
    return parsed
  }
  if (Array.isArray(parsed)) {
    // MCP content-block array — concatenate text blocks and re-parse.
    const text = parsed
      .flatMap((block) =>
        isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
      )
      .join('')
      .trim()
    if (text.length === 0) {
      return trimmed
    }
    try {
      const inner = JSON.parse(text)
      return isRecord(inner) ? inner : text
    } catch {
      return text
    }
  }
  return trimmed
}

export const parseChatToolResult = (output: string): ExternalChatResult => {
  const payload = coerceChatPayload(output)
  if (typeof payload === 'string') {
    return {
      reply: payload,
      conversationId: null,
      userTurnId: null,
      turnId: null,
      activities: [],
      cards: [],
    }
  }
  return {
    reply: firstString(payload, ['reply', 'message', 'text', 'output']) ?? '',
    conversationId: firstString(payload, ['conversationId', 'conversation_id']),
    userTurnId: firstString(payload, ['userTurnId', 'user_turn_id']),
    turnId: firstString(payload, ['turnId', 'turn_id']),
    activities: asArray(payload.activities),
    cards: asArray(payload.cards),
  }
}

/**
 * Activity status vocabulary (planned/queued/running/needs_input/complete/
 * failed/cancelled) mapped onto the card status vocabulary
 * (idle/queued/running/needs_setup/completed/failed/warning).
 */
const ACTIVITY_STATUS_MAP: Record<string, IntegrationUiCardStatus> = {
  planned: 'queued',
  queued: 'queued',
  running: 'running',
  in_progress: 'running',
  needs_input: 'needs_setup',
  needs_setup: 'needs_setup',
  complete: 'completed',
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'warning',
  canceled: 'warning',
}

const CARD_STATUSES = new Set<string>([
  'idle',
  'queued',
  'running',
  'needs_setup',
  'completed',
  'failed',
  'warning',
])

const mapStatus = (raw: string | null, fallback: IntegrationUiCardStatus): IntegrationUiCardStatus => {
  if (!raw) return fallback
  const lowered = raw.toLowerCase()
  // A value already in the card vocabulary (e.g. a card's own `warning`) is
  // taken verbatim; otherwise fall back to the activity-status translation.
  if (CARD_STATUSES.has(lowered)) return lowered as IntegrationUiCardStatus
  return ACTIVITY_STATUS_MAP[lowered] ?? fallback
}

const mapFields = (value: unknown): IntegrationUiCard['fields'] => {
  const fields = asArray(value).flatMap((raw) => {
    if (!isRecord(raw)) return []
    const label = firstString(raw, ['label', 'name', 'key'])
    const fieldValue = firstString(raw, ['value', 'text', 'detail'])
    return label && fieldValue ? [{ label, value: fieldValue }] : []
  })
  return fields.length > 0 ? fields : undefined
}

const mapActions = (value: unknown): IntegrationUiCard['actions'] => {
  const actions = asArray(value).flatMap((raw) => {
    if (!isRecord(raw)) return []
    const label = firstString(raw, ['label', 'title', 'text'])
    if (!label) return []
    const href = firstString(raw, ['href', 'url'])
    const variant: 'primary' | 'secondary' | undefined =
      raw.variant === 'primary' || raw.variant === 'secondary' ? raw.variant : undefined
    return [{ label, ...(href ? { href } : {}), ...(variant ? { variant } : {}) }]
  })
  return actions.length > 0 ? actions : undefined
}

const activityToCard = (productSlug: string, raw: unknown): IntegrationUiCard | null => {
  if (!isRecord(raw)) return null
  const title = firstString(raw, ['label', 'title', 'name', 'tool', 'skill', 'effect'])
  if (!title) return null
  const candidate = {
    kind: 'integration' as const,
    productSlug,
    title,
    status: mapStatus(firstString(raw, ['status', 'visibleStatus', 'state']), 'running'),
    summary: firstString(raw, ['summary', 'detail', 'description', 'message']) ?? undefined,
    fields: mapFields(raw.fields),
    actions: mapActions(raw.actions),
  }
  const parsed = IntegrationUiCardSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

const cardToCard = (productSlug: string, raw: unknown): IntegrationUiCard | null => {
  if (!isRecord(raw)) return null
  const title = firstString(raw, ['title', 'label', 'headline', 'name'])
  if (!title) return null
  const candidate = {
    kind: 'integration' as const,
    productSlug,
    title,
    status: mapStatus(firstString(raw, ['status', 'state']), 'completed'),
    summary: firstString(raw, ['summary', 'body', 'description', 'detail']) ?? undefined,
    fields: mapFields(raw.fields),
    actions: mapActions(raw.actions),
  }
  const parsed = IntegrationUiCardSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * Map a parsed chat result's activities + cards onto rendered UI cards. Invalid
 * entries are dropped. Activities render first (they narrate the turn), then the
 * generative cards (the results).
 */
export const mapChatResultToUiCards = (
  productSlug: string,
  result: Pick<ExternalChatResult, 'activities' | 'cards'>,
): IntegrationUiCard[] => [
  ...result.activities.flatMap((raw) => {
    const card = activityToCard(productSlug, raw)
    return card ? [card] : []
  }),
  ...result.cards.flatMap((raw) => {
    const card = cardToCard(productSlug, raw)
    return card ? [card] : []
  }),
]

/** A single "you need to (re-)connect" card for the setup / auth-expired paths. */
export const needsSetupCard = (
  productSlug: string,
  productLabel: string,
  summary: string,
): IntegrationUiCard => ({
  kind: 'integration',
  productSlug,
  title: `Connect ${productLabel}`,
  status: 'needs_setup',
  summary,
})

/** A single "the external service failed" card for the transport-error path. */
export const failedCard = (
  productSlug: string,
  productLabel: string,
  summary: string,
): IntegrationUiCard => ({
  kind: 'integration',
  productSlug,
  title: `${productLabel} is unavailable`,
  status: 'failed',
  summary,
})
