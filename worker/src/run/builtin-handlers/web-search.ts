import { z } from 'zod'
import type {
  LedgerAttribution,
  LedgerIdentityService,
} from '@nessie/runtime'

const LEDGER_SERPER_PATH = '/v1/serper/search'
const LEDGER_SERPER_TIMEOUT_MS = 15_000
const DEFAULT_RESULT_COUNT = 5
const MAX_RESULT_COUNT = 10
const MAX_PAGE = 10
const ALLOWED_IDENTITY_HEADERS = new Set([
  'x-nessie-context',
  'x-uoa-delegation',
])

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
  page: number
  answer: string | null
  results: WebSearchResult[]
  text: string
}

export type WebSearchOptions = {
  attribution: LedgerAttribution
  count?: number
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  ledgerIdentity: LedgerIdentityService | null | undefined
  page?: number
  toolCallId: string
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
 * Search the public web through Nessie's product-bound Ledger proxy. Ledger
 * injects the provider credential and records the raw Serper unit against the
 * signed user/team/agent/run/tool provenance. There is deliberately no direct
 * provider-key or scraping fallback.
 */
export const runWebSearch = async (
  query: string,
  options: WebSearchOptions,
): Promise<WebSearchOutput> => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    throw new WebSearchError('Web search requires a non-empty query.')
  }

  const env = options.env ?? process.env
  const ledgerBaseUrl = env.LEDGER_PUBLIC_URL?.trim()
  const ledgerProxyToken = env.LEDGER_PROXY_TOKEN?.trim()
  if (!ledgerBaseUrl || !ledgerProxyToken) {
    throw new WebSearchError(
      'Web search requires LEDGER_PUBLIC_URL and LEDGER_PROXY_TOKEN.',
    )
  }
  if (!options.ledgerIdentity) {
    throw new WebSearchError(
      'Web search requires configured Ledger signing identity.',
    )
  }
  const toolCallId = options.toolCallId.trim()
  if (!toolCallId) {
    throw new WebSearchError('Web search requires a stable tool call ID.')
  }

  let endpoint: URL
  try {
    const baseUrl = new URL(ledgerBaseUrl)
    if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
    endpoint = new URL(LEDGER_SERPER_PATH, baseUrl.origin)
  } catch {
    throw new WebSearchError(
      'Web search requires LEDGER_PUBLIC_URL to be a valid HTTP(S) URL.',
    )
  }

  const count = Math.min(
    Math.max(1, Math.trunc(options.count ?? DEFAULT_RESULT_COUNT)),
    MAX_RESULT_COUNT,
  )
  const page = Math.min(Math.max(1, Math.trunc(options.page ?? 1)), MAX_PAGE)
  const fetchImpl = options.fetchImpl ?? fetch
  const identityHeaders = await options.ledgerIdentity.requestHeaders(
    {
      ...options.attribution,
      toolCallId,
    },
    { toolCallId },
  )
  const headers = new Headers({
    Authorization: `Bearer ${ledgerProxyToken}`,
    'Content-Type': 'application/json',
  })
  for (const [name, value] of Object.entries(identityHeaders)) {
    if (!ALLOWED_IDENTITY_HEADERS.has(name.toLowerCase()) || !value.trim()) {
      throw new WebSearchError(
        'Ledger signing identity returned an unexpected header.',
      )
    }
    headers.set(name, value)
  }

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ q: trimmedQuery, num: count, page }),
      signal: AbortSignal.timeout(LEDGER_SERPER_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WebSearchError(`Ledger web search request failed: ${reason}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new WebSearchError(
      `Ledger web search returned ${response.status} ${response.statusText}${
        body ? `: ${body.slice(0, 200)}` : ''
      }`,
    )
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const parsed = SerperResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new WebSearchError(
      'Ledger web search returned an unexpected response shape.',
    )
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
    lines.length > 0
      ? lines.join('\n')
      : `No web results found for "${trimmedQuery}" (page ${page}).`

  return {
    query: trimmedQuery,
    page,
    answer,
    results,
    text,
  }
}
