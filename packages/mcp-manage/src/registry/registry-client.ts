import { safeFetch } from '@nessie/runtime'

import { MCP_REGISTRY_BASE_URL, McpLibraryError } from '../library.js'
import { RegistryPageSchema } from './registry-schema.js'

/**
 * Cursor-paged read of the official MCP registry's `/v0/servers`.
 *
 * Egress goes through `safeFetch`, not the platform `fetch`: AGENTS.md requires
 * outbound calls to an operator-supplied address (`baseUrl` is configurable) to
 * be IP-pinned rather than merely validated, so a DNS answer cannot change
 * between the check and the socket. `safeFetch` rather than the connector
 * layer's `pinnedMcpFetch` because this caller has no opinion about redirects
 * and wants them followed and re-vetted hop by hop.
 *
 * Every page is bounded. The registry is a third party: a cursor that never
 * terminates, one that cycles, or one that answers with a gigabyte, must cost a
 * finite number of requests and a finite amount of memory rather than spinning
 * or exhausting a worker.
 */

export const REGISTRY_PAGE_SIZE = 100
export const REGISTRY_MAX_PAGES = 200
export const REGISTRY_MAX_RECORDS = 20_000
/**
 * A page of 100 records measures tens of KiB; this is two orders of magnitude
 * of headroom and still a hard ceiling. Counts alone do not bound bytes, and
 * the sweep runs in-process in the API behind the owner's sync button, so an
 * unbounded `response.json()` on a hostile or broken host is an OOM of the
 * whole server rather than one bad import.
 */
export const REGISTRY_MAX_PAGE_BYTES = 8 * 1024 * 1024
const REGISTRY_REQUEST_TIMEOUT_MS = 20_000

export type RegistryFetchOptions = {
  baseUrl?: string
  /** Injectable for tests; production takes the pinned default below. */
  fetchImpl?: typeof fetch
  pageSize?: number
  maxPages?: number
  maxRecords?: number
  signal?: AbortSignal
}

/** `safeFetch` shaped as the global `fetch`, so the default transport is pinned. */
const pinnedRegistryFetch: typeof fetch = async (input, init) =>
  safeFetch(input instanceof Request ? input.url : input, init)

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max)

const oversizedPage = (): McpLibraryError =>
  new McpLibraryError(
    `MCP registry page exceeded ${REGISTRY_MAX_PAGE_BYTES} bytes`,
  )

/**
 * The response body, refused the moment it passes the cap.
 *
 * A declared `content-length` is checked first because it costs nothing, but it
 * is only a claim: a chunked or lying response is caught by counting the bytes
 * as they arrive, and the read is cancelled rather than drained so an endless
 * body stops arriving instead of merely being thrown away.
 */
const readBoundedBody = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > REGISTRY_MAX_PAGE_BYTES) {
    throw oversizedPage()
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > REGISTRY_MAX_PAGE_BYTES) {
      await reader.cancel()
      throw oversizedPage()
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

const fetchPage = async (
  url: string,
  options: RegistryFetchOptions,
): Promise<{ servers: unknown[]; nextCursor: string | null }> => {
  const fetchImpl = options.fetchImpl ?? pinnedRegistryFetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new McpLibraryError(
      `MCP registry unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) {
    throw new McpLibraryError(`MCP registry returned HTTP ${response.status}`)
  }

  const body = await readBoundedBody(response)
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new McpLibraryError('MCP registry returned a body that is not JSON')
  }
  const parsed = RegistryPageSchema.safeParse(payload)
  if (!parsed.success) {
    throw new McpLibraryError('MCP registry returned an unexpected payload shape')
  }
  return {
    servers: parsed.data.servers,
    nextCursor: parsed.data.metadata?.nextCursor ?? null,
  }
}

export type RegistryRecordPage = {
  /** 1-based, so a progress line can say "page 3" without arithmetic. */
  page: number
  records: unknown[]
}

/**
 * Every server record the registry will hand over, oldest page first, as raw
 * `unknown` values — validation is per record and belongs to the caller, so a
 * poison record is one skipped app rather than one lost page.
 *
 * Grouped by page rather than flattened because the page *is* the unit of
 * progress: a full walk is dozens of requests over several minutes, and a
 * caller that cannot say which one it is on cannot tell a slow sweep from a
 * hung one. An empty page is still yielded for that reason.
 */
export async function* iterateRegistryPages(
  options: RegistryFetchOptions = {},
): AsyncGenerator<RegistryRecordPage, void, void> {
  const baseUrl = options.baseUrl ?? MCP_REGISTRY_BASE_URL
  const pageSize = clamp(options.pageSize ?? REGISTRY_PAGE_SIZE, 1, REGISTRY_PAGE_SIZE)
  const maxPages = clamp(options.maxPages ?? REGISTRY_MAX_PAGES, 1, REGISTRY_MAX_PAGES)
  const maxRecords = clamp(
    options.maxRecords ?? REGISTRY_MAX_RECORDS,
    1,
    REGISTRY_MAX_RECORDS,
  )

  let cursor: string | null = null
  let emitted = 0
  const seenCursors = new Set<string>()

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL('/v0/servers', baseUrl)
    url.searchParams.set('limit', String(pageSize))
    if (cursor) url.searchParams.set('cursor', cursor)

    const { servers, nextCursor } = await fetchPage(url.toString(), options)
    const room = maxRecords - emitted
    const records = servers.length > room ? servers.slice(0, room) : servers
    emitted += records.length
    yield { page, records }

    if (emitted >= maxRecords) return
    if (!nextCursor) return
    // A registry that hands back a cursor it already gave us is looping; the
    // page bound would eventually catch it, but not before re-importing the
    // same slice a hundred times.
    if (seenCursors.has(nextCursor)) return
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}
