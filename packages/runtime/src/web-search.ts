import type { LedgerAttribution } from './ledger.js'
import type { LedgerIdentityService } from './ledger-identity.js'
import {
  parseCanonicalSearchResponse,
  parseSerperSearchResponse,
  renderWebSearchText,
  type WebSearchAnswerSource,
  type WebSearchKnowledgePanel,
  type WebSearchResult,
} from './web-search-response.js'

export type {
  WebSearchAnswerSource,
  WebSearchKnowledgePanel,
  WebSearchResult,
} from './web-search-response.js'

/**
 * The single-provider passthrough: Ledger injects the Serper key, meters the
 * search, and returns Serper's own body. Used when the deployment has no search
 * Purpose API configured.
 */
const LEDGER_SERPER_PATH = '/v1/serper/search'
/**
 * The provider-agnostic route: a Purpose API whose route list Ledger walks in
 * priority order, spilling to the next provider on saturation and answering in
 * the canonical `search.v1` shape. Adding SerpAPI, Brave or Perplexity is a
 * route added to that list — no Nessie change, which is the whole point of
 * addressing a purpose rather than a provider.
 */
const ledgerPurposeSearchPath = (purposeApiId: string): string =>
  `/v1/purpose/${encodeURIComponent(purposeApiId)}/search`

const LEDGER_SEARCH_TIMEOUT_MS = 15_000
const DEFAULT_RESULT_COUNT = 5
export const MAX_WEB_SEARCH_RESULT_COUNT = 10
export const MAX_WEB_SEARCH_PAGE = 10
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

export type WebSearchOutput = {
  /** Which provider Ledger actually used. */
  provider: string
  query: string
  page: number
  count: number
  answer: string | null
  answerSource: WebSearchAnswerSource | null
  knowledgePanel: WebSearchKnowledgePanel | null
  results: WebSearchResult[]
  related: string[]
  /**
   * A full page implies another one. No provider reports a total, so this is
   * the same inference a SERP's own "next" arrow makes.
   */
  hasMore: boolean
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

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(1, Math.trunc(value ?? fallback)), max)

/**
 * Resolve the Ledger endpoint this deployment searches through.
 *
 * `NESSIE_LEDGER_SEARCH_PURPOSE_API_ID` is the switch, mirroring
 * `NESSIE_LEDGER_IMAGE_PURPOSE_API_ID` for image generation: set it and Ledger
 * owns the provider chain behind one address; leave it unset and the single
 * Serper service route answers, exactly as before.
 */
const resolveSearchEndpoint = (env: NodeJS.ProcessEnv): URL => {
  const ledgerBaseUrl = env.LEDGER_PUBLIC_URL?.trim()
  if (!ledgerBaseUrl) {
    throw new WebSearchError(
      'Web search requires LEDGER_PUBLIC_URL and LEDGER_PROXY_TOKEN.',
    )
  }
  const purposeApiId = env.NESSIE_LEDGER_SEARCH_PURPOSE_API_ID?.trim()

  try {
    const baseUrl = new URL(ledgerBaseUrl)
    if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
    return new URL(
      purposeApiId ? ledgerPurposeSearchPath(purposeApiId) : LEDGER_SERPER_PATH,
      baseUrl.origin,
    )
  } catch {
    throw new WebSearchError(
      'Web search requires LEDGER_PUBLIC_URL to be a valid HTTP(S) URL.',
    )
  }
}

/**
 * Search the public web through Nessie's product-bound Ledger proxy. Ledger
 * injects the provider credential and records the raw search unit against the
 * signed user/team/agent/run/tool provenance. There is deliberately no direct
 * provider-key or scraping fallback — and no per-provider branch here either:
 * which engine ran is Ledger's decision, and both wire formats it can answer
 * with normalise to one shape (`web-search-response.ts`).
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
  const ledgerProxyToken = env.LEDGER_PROXY_TOKEN?.trim()
  if (!ledgerProxyToken) {
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

  const endpoint = resolveSearchEndpoint(env)
  const count = clamp(options.count, DEFAULT_RESULT_COUNT, MAX_WEB_SEARCH_RESULT_COUNT)
  const page = clamp(options.page, 1, MAX_WEB_SEARCH_PAGE)
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
      // The one body both routes accept: the Purpose API's request schema is
      // strict, so nothing beyond these three fields may be sent.
      body: JSON.stringify({ q: trimmedQuery, num: count, page }),
      signal: AbortSignal.timeout(LEDGER_SEARCH_TIMEOUT_MS),
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
  // Canonical first: only the `search.v1` envelope carries a `search` object,
  // so the two shapes cannot be confused and neither route is hard-coded here.
  const parsed =
    parseCanonicalSearchResponse(payload, count)
    ?? parseSerperSearchResponse(payload, count)
  if (!parsed) {
    throw new WebSearchError(
      'Ledger web search returned an unexpected response shape.',
    )
  }

  return {
    provider: parsed.provider,
    query: trimmedQuery,
    page,
    count,
    answer: parsed.answer,
    answerSource: parsed.answerSource,
    knowledgePanel: parsed.knowledgePanel,
    results: parsed.results,
    related: parsed.related,
    hasMore: parsed.results.length >= count,
    text: renderWebSearchText({ page, query: trimmedQuery, response: parsed }),
  }
}
