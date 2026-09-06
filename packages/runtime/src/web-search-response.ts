import { z } from 'zod'

/**
 * One provider-neutral shape for every search route Ledger can answer with.
 *
 * Nessie deliberately does not know which search provider ran: Ledger owns the
 * provider chain (Serper today; SerpAPI, Brave and Perplexity are already
 * catalogued there), and a Purpose API route list can reorder or spill between
 * them without a Nessie deploy. What Nessie codes against is this normalised
 * result — parsed either from Ledger's canonical `search.v1` envelope (the
 * Purpose API route, which always answers canonically because a multi-provider
 * walk has no predictable wire format) or from Serper's own body (the single
 * service passthrough). Adding a provider is a Ledger route change, never a
 * second parser here.
 */

export type WebSearchResult = {
  position: number
  title: string
  url: string
  snippet: string
  /** Provider-supplied publication date, when there is one. */
  date?: string
  /** Display domain, shown under the title the way a SERP shows it. */
  source?: string
}

/** A featured-snippet style direct answer, with the page it was lifted from. */
export type WebSearchAnswerSource = {
  title?: string
  url?: string
}

export type WebSearchKnowledgePanel = {
  title?: string
  description?: string
  url?: string
}

export type WebSearchResponse = {
  /** Which provider actually answered, as Ledger reported it. */
  provider: string
  answer: string | null
  answerSource: WebSearchAnswerSource | null
  knowledgePanel: WebSearchKnowledgePanel | null
  results: WebSearchResult[]
  related: string[]
}

const trimmed = (value: string | undefined | null): string | undefined => {
  const text = value?.trim()
  return text && text.length > 0 ? text : undefined
}

/** `{ title: 'x' }` when there is a value, `{}` when there is not. */
const optional = <K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> => (value === undefined ? {} : ({ [key]: value } as Record<K, string>))

/** `https://www.example.com/a/b` → `example.com`, the way a SERP shows it. */
export const displayDomain = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const CanonicalResultSchema = z.object({
  position: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  source: z.string().optional(),
})

/** Ledger's `search.v1` envelope — the shape every provider is translated into. */
export const CanonicalSearchResponseSchema = z.object({
  search: z.object({
    provider: z.string().optional(),
    q: z.string().optional(),
    page: z.number().optional(),
    results: z.array(CanonicalResultSchema).optional(),
    knowledge_graph: z
      .object({
        title: z.string().optional(),
        url: z.string().optional(),
        description: z.string().optional(),
      })
      .optional(),
    related: z.array(z.string()).optional(),
    fidelity: z.string().optional(),
  }),
})

const SerperOrganicSchema = z.object({
  title: z.string().optional(),
  link: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
  position: z.number().optional(),
})

/**
 * Serper's own body, returned by the single-service passthrough route.
 *
 * `organic` is required — every other field is genuinely optional, so without
 * it any JSON object at all would parse as an empty result page and a broken
 * upstream would read as "nothing found". Ledger's own Serper translator makes
 * the same call for the same reason.
 */
export const SerperSearchResponseSchema = z.object({
  answerBox: z
    .object({
      answer: z.string().optional(),
      snippet: z.string().optional(),
      title: z.string().optional(),
      link: z.string().optional(),
    })
    .optional(),
  knowledgeGraph: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      descriptionLink: z.string().optional(),
      website: z.string().optional(),
    })
    .optional(),
  organic: z.array(SerperOrganicSchema),
  relatedSearches: z.array(z.object({ query: z.string().optional() })).optional(),
})

type RawResult = {
  title?: string
  url?: string
  snippet?: string
  date?: string
  source?: string
}

/**
 * Drop results with no URL and renumber from one. A provider's own `position`
 * is not reused: it counts within *its* page, and a result that was dropped
 * would leave a gap the card would render as a missing rank.
 */
const normaliseResults = (raw: RawResult[], limit: number): WebSearchResult[] => {
  const seen = new Set<string>()
  const results: WebSearchResult[] = []
  for (const entry of raw) {
    const url = trimmed(entry.url)
    if (!url || seen.has(url) || results.length >= limit) continue
    seen.add(url)
    results.push({
      position: results.length + 1,
      title: trimmed(entry.title) ?? 'Untitled result',
      url,
      snippet: trimmed(entry.snippet) ?? '',
      ...optional('date', trimmed(entry.date)),
      ...optional('source', trimmed(entry.source) ?? displayDomain(url)),
    })
  }
  return results
}

export const parseCanonicalSearchResponse = (
  payload: unknown,
  limit: number,
): WebSearchResponse | null => {
  const parsed = CanonicalSearchResponseSchema.safeParse(payload)
  if (!parsed.success) return null

  const search = parsed.data.search
  const graph = search.knowledge_graph
  const knowledgePanel: WebSearchKnowledgePanel = {
    ...optional('title', trimmed(graph?.title)),
    ...optional('description', trimmed(graph?.description)),
    ...optional('url', trimmed(graph?.url)),
  }

  return {
    provider: trimmed(search.provider) ?? 'ledger',
    // The canonical envelope carries no featured snippet: a knowledge-graph
    // description is the only direct answer every provider can honestly serve.
    answer: trimmed(graph?.description) ?? null,
    answerSource: null,
    knowledgePanel: Object.keys(knowledgePanel).length > 0 ? knowledgePanel : null,
    results: normaliseResults(
      (search.results ?? []).map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.snippet,
        date: entry.date,
        source: entry.source,
      })),
      limit,
    ),
    related: (search.related ?? []).map((query) => query.trim()).filter(Boolean),
  }
}

export const parseSerperSearchResponse = (
  payload: unknown,
  limit: number,
): WebSearchResponse | null => {
  const parsed = SerperSearchResponseSchema.safeParse(payload)
  if (!parsed.success) return null

  const body = parsed.data
  const graph = body.knowledgeGraph
  const knowledgePanel: WebSearchKnowledgePanel = {
    ...optional('title', trimmed(graph?.title)),
    ...optional('description', trimmed(graph?.description)),
    ...optional('url', trimmed(graph?.website) ?? trimmed(graph?.descriptionLink)),
  }
  const answerSource: WebSearchAnswerSource = {
    ...optional('title', trimmed(body.answerBox?.title)),
    ...optional('url', trimmed(body.answerBox?.link)),
  }
  const answer =
    trimmed(body.answerBox?.answer)
    ?? trimmed(body.answerBox?.snippet)
    ?? trimmed(graph?.description)
    ?? null

  return {
    provider: 'serper',
    answer,
    answerSource: Object.keys(answerSource).length > 0 ? answerSource : null,
    knowledgePanel: Object.keys(knowledgePanel).length > 0 ? knowledgePanel : null,
    results: normaliseResults(
      body.organic.map((entry) => ({
        title: entry.title,
        url: entry.link,
        snippet: entry.snippet,
        date: entry.date,
      })),
      limit,
    ),
    related: (body.relatedSearches ?? [])
      .map((entry) => entry.query?.trim() ?? '')
      .filter(Boolean),
  }
}

/**
 * The model reads text, not JSON. One rendering for every provider, so a route
 * change never changes what an agent sees.
 */
export const renderWebSearchText = (input: {
  query: string
  page: number
  response: WebSearchResponse
}): string => {
  const { query, page, response } = input
  const lines: string[] = []
  if (response.answer) {
    lines.push(`Answer: ${response.answer}`, '')
  }
  for (const entry of response.results) {
    lines.push(`${entry.position}. ${entry.title} - ${entry.url}`)
    if (entry.snippet) {
      lines.push(`   ${entry.snippet}`)
    }
  }
  if (response.related.length > 0) {
    lines.push('', `Related searches: ${response.related.join(', ')}`)
  }

  return lines.length > 0
    ? lines.join('\n')
    : `No web results found for "${query}" (page ${page}).`
}
