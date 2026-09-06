import { z } from 'zod'

/**
 * The search card — a page of web results, rendered in the conversation the
 * way a search engine renders them.
 *
 * This is a **presentational** card, deliberately not an `AgentCard`. An agent
 * card is an interactive object: its authority is a row, its press is claimed
 * once by a conditional UPDATE, and who may press is a per-viewer server
 * decision. A page of search results has none of that — nothing is pressed,
 * nothing resolves, and every viewer sees the same thing — so it rides in the
 * message's own metadata like the integration `uiCards` do, and the card
 * vocabulary keeps its meaning.
 *
 * The payload is written by the **tool**, from the provider response, never
 * retyped by the model: a card whose links the model composed could misquote a
 * URL, which is the one thing a source list must not do.
 *
 * Paging is live. The card renders the page the agent fetched; `Next` runs the
 * next page through `POST /api/web-search`, signed as the person who clicked,
 * so a card is a place to search from rather than a snapshot of one search.
 */

export const WEB_SEARCH_CARD_SCHEMA_VERSION = 1
export const WEB_SEARCH_CARD_MAX_RESULTS = 10
export const WEB_SEARCH_CARD_MAX_RELATED = 8
export const WEB_SEARCH_CARD_MAX_PAGE = 10

/**
 * A result URL is rendered as a link and opened in the viewer's browser, so the
 * scheme is checked here rather than trusted from the provider: `http(s)` only,
 * never `javascript:`, `data:` or an app scheme.
 */
const WebResultUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    'Search result links must be http(s).',
  )

export const WebSearchCardResultSchema = z
  .object({
    position: z.number().int().min(1).max(100),
    title: z.string().trim().min(1).max(300),
    url: WebResultUrlSchema,
    snippet: z.string().trim().max(1000).optional(),
    date: z.string().trim().max(60).optional(),
    /** Display domain, shown under the title the way a SERP shows it. */
    source: z.string().trim().max(200).optional(),
  })
  .strict()
export type WebSearchCardResult = z.infer<typeof WebSearchCardResultSchema>

export const WebSearchCardPanelSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(1200).optional(),
    url: WebResultUrlSchema.optional(),
  })
  .strict()
export type WebSearchCardPanel = z.infer<typeof WebSearchCardPanelSchema>

export const WebSearchCardSchema = z
  .object({
    schemaVersion: z.literal(WEB_SEARCH_CARD_SCHEMA_VERSION),
    /**
     * Which engine answered, as Ledger reported it. Shown as a provenance line:
     * the person is entitled to know a result came from Serper rather than
     * Brave when the deployment's route list can spill between them.
     */
    provider: z.string().trim().min(1).max(60),
    query: z.string().trim().min(1).max(400),
    page: z.number().int().min(1).max(WEB_SEARCH_CARD_MAX_PAGE),
    count: z.number().int().min(1).max(WEB_SEARCH_CARD_MAX_RESULTS),
    answer: z.string().trim().max(2000).optional(),
    answerSource: WebSearchCardPanelSchema.optional(),
    knowledgePanel: WebSearchCardPanelSchema.optional(),
    results: z.array(WebSearchCardResultSchema).max(WEB_SEARCH_CARD_MAX_RESULTS),
    related: z.array(z.string().trim().min(1).max(200)).max(WEB_SEARCH_CARD_MAX_RELATED).optional(),
    /** A full page implies another one; the pager offers `Next` only then. */
    hasMore: z.boolean(),
  })
  .strict()
export type WebSearchCard = z.infer<typeof WebSearchCardSchema>

/**
 * The durable payload on the assistant message. Unlike `agentCard`, the whole
 * card is here rather than a pointer: it is immutable, viewer-independent, and
 * carries no decision a server would have to make per reader.
 */
export const WebSearchCardMessageMetadataSchema = z
  .object({ webSearch: WebSearchCardSchema })
  .strict()
export type WebSearchCardMessageMetadata = z.infer<typeof WebSearchCardMessageMetadataSchema>

/** The one reader for a message's search card — used by the admin and by tests. */
export const readWebSearchCard = (metadata: unknown): WebSearchCard | null => {
  const raw = (metadata as { webSearch?: unknown } | null | undefined)?.webSearch
  if (raw === undefined || raw === null) return null
  const parsed = WebSearchCardSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * `POST /api/web-search` — the card's pager, and the only human-initiated
 * search door. It runs the same Ledger-routed search the builtin tool runs,
 * signed as the person who clicked, so the spend is attributed to them.
 */
export const WebSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(400),
    page: z.number().int().min(1).max(WEB_SEARCH_CARD_MAX_PAGE).optional(),
    count: z.number().int().min(1).max(WEB_SEARCH_CARD_MAX_RESULTS).optional(),
  })
  .strict()
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>

export const WebSearchResponseSchema = WebSearchCardSchema
export type WebSearchResponsePayload = z.infer<typeof WebSearchResponseSchema>
