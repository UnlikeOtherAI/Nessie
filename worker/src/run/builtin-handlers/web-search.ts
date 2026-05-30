import { z } from 'zod'

const SERPER_ENDPOINT = 'https://google.serper.dev/search'
const SERPER_TIMEOUT_MS = 15_000
const DEFAULT_RESULT_COUNT = 5
const MAX_RESULT_COUNT = 10

export class WebSearchError extends Error {
  override readonly name = 'WebSearchError'

  constructor(message: string) {
    super(message)
  }
}

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
}

export type WebSearchOutput = {
  query: string
  answer: string | null
  results: WebSearchResult[]
  text: string
}

const SerperOrganicSchema = z.object({
  title: z.string().optional(),
  link: z.string().optional(),
  snippet: z.string().optional(),
})

const SerperResponseSchema = z.object({
  answerBox: z
    .object({
      answer: z.string().optional(),
      snippet: z.string().optional(),
    })
    .optional(),
  knowledgeGraph: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  organic: z.array(SerperOrganicSchema).optional(),
})

const resolveAnswer = (
  parsed: z.infer<typeof SerperResponseSchema>,
): string | null =>
  parsed.answerBox?.answer ??
  parsed.answerBox?.snippet ??
  parsed.knowledgeGraph?.description ??
  null

/**
 * Search the public web via serper.dev (Google results). Requires
 * `SERPER_API_KEY` to be configured — there is no scraping fallback.
 */
export const runWebSearch = async (
  query: string,
  options: { count?: number; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchOutput> => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    throw new WebSearchError('Web search requires a non-empty query.')
  }

  const apiKey = process.env.SERPER_API_KEY?.trim()
  if (!apiKey) {
    throw new WebSearchError(
      'Web search is not configured: set SERPER_API_KEY to enable serper.dev search.',
    )
  }

  const count = Math.min(
    Math.max(1, Math.trunc(options.count ?? DEFAULT_RESULT_COUNT)),
    MAX_RESULT_COUNT,
  )
  const fetchImpl = options.fetchImpl ?? fetch

  let response: Response
  try {
    response = await fetchImpl(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ q: trimmedQuery, num: count }),
      signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WebSearchError(`serper.dev request failed: ${reason}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new WebSearchError(
      `serper.dev returned ${response.status} ${response.statusText}${
        body ? `: ${body.slice(0, 200)}` : ''
      }`,
    )
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const parsed = SerperResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new WebSearchError('serper.dev returned an unexpected response shape.')
  }

  const answer = resolveAnswer(parsed.data)
  const results: WebSearchResult[] = (parsed.data.organic ?? [])
    .slice(0, count)
    .map((entry) => ({
      title: entry.title?.trim() || 'Untitled result',
      url: entry.link?.trim() || '',
      snippet: entry.snippet?.trim() || '',
    }))
    .filter((entry) => entry.url.length > 0)

  const lines: string[] = []
  if (answer) {
    lines.push(`Answer: ${answer}`, '')
  }
  results.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.title} - ${entry.url}`)
    if (entry.snippet) {
      lines.push(`   ${entry.snippet}`)
    }
  })

  const text =
    lines.length > 0 ? lines.join('\n') : `No web results found for "${trimmedQuery}".`

  return {
    query: trimmedQuery,
    answer,
    results,
    text,
  }
}
