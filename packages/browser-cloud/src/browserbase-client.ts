import { safeFetch } from '@nessie/runtime'

import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'

/**
 * Browserbase's REST surface, reached only through `safeFetch` so the socket
 * is pinned to the addresses that were validated.
 *
 * Every session is created with the platform's observability and assistance
 * defaults turned OFF:
 *
 * - `recordSession: false` — recording is ON by default, and a login handoff
 *   is a person typing a password into this session. A recording would be
 *   replayable from the Browserbase dashboard by whoever holds the account,
 *   entirely outside Nessie's disclosure predicate.
 * - `logSession: false` — session logs carry network-level request data.
 * - `solveCaptchas: false` — our stated policy is that a human solves
 *   challenges in the live view. Leaving the platform default on would make
 *   that claim false.
 * - `timeout` — the session's own hard stop, so a dead worker cannot leave a
 *   browser running past its TTL.
 */

const BROWSERBASE_API_ORIGIN = 'https://api.browserbase.com'

/** Hosts a Browserbase-issued URL is allowed to point at. */
const BROWSERBASE_HOST_SUFFIXES = ['.browserbase.com', 'browserbase.com'] as const

export const isBrowserbaseHost = (host: string): boolean => {
  const lowered = host.toLowerCase()
  return BROWSERBASE_HOST_SUFFIXES.some(
    (suffix) => lowered === suffix || lowered.endsWith(suffix),
  )
}

/**
 * A URL Browserbase handed back (CDP connect, live view) must still point at
 * Browserbase. The response is authenticated, but a compromised or changed
 * upstream must not be able to aim our socket somewhere else.
 */
export const assertBrowserbaseUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.UNTRUSTED_ENDPOINT,
      'Browserbase returned a malformed URL.',
    )
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (!secure || !isBrowserbaseHost(url.hostname)) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.UNTRUSTED_ENDPOINT,
      'Browserbase returned a URL outside its own origin.',
    )
  }
  return url
}

export type BrowserbaseCredentials = {
  apiKey: string
  /**
   * Browserbase resolves the project from the API key, so this is optional and
   * nothing in Nessie asks for one. It is still sent when a connection carries
   * one — installs made before 2026-09-06 stored it, and their sessions and
   * profiles are already scoped to it.
   */
  projectId?: string | null
}

export type CreateSessionInput = {
  /** Seconds. Mirrored from the Nessie session TTL. */
  timeoutSeconds: number
  /** Attach a persistent context. Absent = ephemeral. */
  contextId?: string
  persistContext?: boolean
}

export type BrowserbaseContext = { id: string }

export type BrowserbaseSession = {
  id: string
  connectUrl: string
  status: string
}

export type BrowserbaseLiveView = {
  /** The interactive full-page live view for the active tab. */
  debuggerFullscreenUrl: string
  pages: Array<{
    id: string
    url: string
    title: string
    debuggerFullscreenUrl: string
  }>
}

export type BrowserbaseClient = {
  createSession: (input: CreateSessionInput) => Promise<BrowserbaseSession>
  endSession: (sessionId: string) => Promise<void>
  liveView: (sessionId: string) => Promise<BrowserbaseLiveView>
  /** Persistent browser state — cookies, localStorage — encrypted at rest. */
  createContext: () => Promise<BrowserbaseContext>
  deleteContext: (contextId: string) => Promise<void>
}

type FetchLike = typeof safeFetch

const readErrorBody = async (response: Response): Promise<string> => {
  try {
    const text = await response.text()
    return text.slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * Browserbase reuses 429 for both concurrency exhaustion and the
 * session-creation rate limit; both are the same thing to a caller — capacity.
 * 401/403 is a key problem the connection must surface as `needs_attention`
 * rather than retry forever.
 */
const failFor = async (response: Response, action: string): Promise<never> => {
  const detail = await readErrorBody(response)
  if (response.status === 401 || response.status === 403) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED,
      `Browserbase rejected the API key while ${action}.`,
      response.status,
    )
  }
  if (response.status === 429) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.CAPACITY,
      'Browserbase is at its concurrency or session-creation limit.',
      response.status,
    )
  }
  throw new CloudBrowserError(
    CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
    `Browserbase failed while ${action} (${response.status}). ${detail}`.trim(),
    response.status,
  )
}

export const createBrowserbaseClient = (
  credentials: BrowserbaseCredentials,
  options: { fetchImpl?: FetchLike; origin?: string } = {},
): BrowserbaseClient => {
  const origin = options.origin ?? BROWSERBASE_API_ORIGIN
  const fetchImpl = options.fetchImpl ?? safeFetch
  const headers = {
    'content-type': 'application/json',
    'x-bb-api-key': credentials.apiKey,
  }
  // Spread into each body, so a connection with no project id sends no
  // `projectId` field at all rather than `null` — which the API reads as a
  // project named null and refuses.
  const projectScope = credentials.projectId ? { projectId: credentials.projectId } : {}

  const request = async (
    path: string,
    init: { method: string; body?: unknown },
    action: string,
  ): Promise<Response> => {
    let response: Response
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (error) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
        `Browserbase could not be reached while ${action}: ${(error as Error).message}`,
      )
    }
    if (!response.ok) return failFor(response, action)
    return response
  }

  return {
    createSession: async (input) => {
      const response = await request(
        '/v1/sessions',
        {
          method: 'POST',
          body: {
            ...projectScope,
            timeout: input.timeoutSeconds,
            browserSettings: {
              // See the file header: none of these are cosmetic.
              recordSession: false,
              logSession: false,
              solveCaptchas: false,
              ...(input.contextId
                ? { context: { id: input.contextId, persist: input.persistContext ?? false } }
                : {}),
            },
          },
        },
        'creating a browser session',
      )
      const body = (await response.json()) as {
        id?: unknown
        connectUrl?: unknown
        status?: unknown
      }
      if (typeof body.id !== 'string' || typeof body.connectUrl !== 'string') {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
          'Browserbase returned a session without an id or connect URL.',
        )
      }
      // Validated here rather than at dial time so a bad endpoint fails while
      // the session can still be released.
      assertBrowserbaseUrl(body.connectUrl)
      return {
        id: body.id,
        connectUrl: body.connectUrl,
        status: typeof body.status === 'string' ? body.status : 'RUNNING',
      }
    },

    endSession: async (sessionId) => {
      await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          // The documented release body is `{status}` alone; the project was
          // never needed here and is not sent even when one is stored.
          body: { status: 'REQUEST_RELEASE' },
        },
        'releasing a browser session',
      )
    },

    createContext: async () => {
      const response = await request(
        '/v1/contexts',
        { method: 'POST', body: { ...projectScope } },
        'creating a browser profile',
      )
      const body = (await response.json()) as { id?: unknown }
      if (typeof body.id !== 'string') {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
          'Browserbase returned a profile without an id.',
        )
      }
      return { id: body.id }
    },

    deleteContext: async (contextId) => {
      await request(
        `/v1/contexts/${encodeURIComponent(contextId)}`,
        { method: 'DELETE' },
        'deleting a browser profile',
      )
    },

    liveView: async (sessionId) => {
      const response = await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/debug`,
        { method: 'GET' },
        'reading the live view',
      )
      const body = (await response.json()) as {
        debuggerFullscreenUrl?: unknown
        pages?: unknown
      }
      if (typeof body.debuggerFullscreenUrl !== 'string') {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
          'Browserbase returned no live view URL.',
        )
      }
      assertBrowserbaseUrl(body.debuggerFullscreenUrl)
      const pages = Array.isArray(body.pages)
        ? body.pages.flatMap((page) => {
          const row = page as Record<string, unknown>
          if (typeof row.debuggerFullscreenUrl !== 'string') return []
          assertBrowserbaseUrl(row.debuggerFullscreenUrl)
          return [{
            id: typeof row.id === 'string' ? row.id : '',
            url: typeof row.url === 'string' ? row.url : '',
            title: typeof row.title === 'string' ? row.title : '',
            debuggerFullscreenUrl: row.debuggerFullscreenUrl,
          }]
        })
        : []
      return { debuggerFullscreenUrl: body.debuggerFullscreenUrl, pages }
    },
  }
}
