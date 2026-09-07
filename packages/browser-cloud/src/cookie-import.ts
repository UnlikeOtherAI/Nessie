import { connectCdp, type CdpClient } from './cdp-client.js'
import { ensureAgentBrowser } from './agent-browser.js'
import { recordAgentBrowserLogin } from './agent-browser-access.js'
import {
  CLOUD_BROWSER_ERROR_CODES,
  CloudBrowserError,
  CloudBrowserUnknownOutcomeError,
} from './errors.js'
import {
  openPersonalBrowserAccessSession,
  type PersonalBrowser,
} from './personal-access-grant.js'
import { releaseCloudBrowserSession, type CloudBrowserDeps } from './session-lifecycle.js'

export type ImportedBrowserCookie = {
  domain: string
  expirationDate?: number
  hostOnly: boolean
  httpOnly: boolean
  name: string
  path: string
  sameSite: 'lax' | 'no_restriction' | 'strict' | 'unspecified'
  secure: boolean
  session: boolean
  value: string
}

const sameSite = (value: ImportedBrowserCookie['sameSite']): 'Lax' | 'None' | 'Strict' | undefined => (
  value === 'lax' ? 'Lax' : value === 'no_restriction' ? 'None' : value === 'strict' ? 'Strict' : undefined
)

const cookieAppliesToHost = (cookie: ImportedBrowserCookie, host: string): boolean => {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase()
  return cookie.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`)
}

/** A cookie path has no query or fragment and resolves below the selected host. */
const cookieUrl = (cookie: ImportedBrowserCookie, origin: string): string | null => {
  if (!cookie.path.startsWith('/')) return null
  try {
    const url = new URL(cookie.path, `${origin}/`)
    return url.origin === origin && url.pathname === cookie.path && !url.search && !url.hash
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/**
 * Make a copy scoped to the chosen host. A source domain cookie can be valid
 * for siblings, but this destination copy intentionally omits `domain` and
 * uses a selected-host URL, so it cannot grant those siblings access.
 */
const cdpCookie = (cookie: ImportedBrowserCookie, origin: string): Record<string, unknown> | null => {
  const url = cookieUrl(cookie, origin)
  if (!url || !cookie.name || !cookieAppliesToHost(cookie, new URL(origin).hostname)) return null
  return {
    ...(cookie.session || cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite) } : {}),
    secure: cookie.secure,
    url,
    value: cookie.value,
  }
}

export const prepareImportedCookies = (
  imports: Array<{ cookies: ImportedBrowserCookie[]; origin: string }>,
): Array<Record<string, unknown>> => {
  const cookies: Array<Record<string, unknown>> = []
  for (const entry of imports) {
    let origin: URL
    try {
      origin = new URL(entry.origin)
    } catch {
      throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Selected-site cookies cannot be imported safely.')
    }
    if (origin.protocol !== 'https:' || origin.origin !== entry.origin) {
      throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Selected-site cookies cannot be imported safely.')
    }
    for (const cookie of entry.cookies) {
      const transformed = cdpCookie(cookie, entry.origin)
      if (!transformed) {
        throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Selected-site cookies cannot be imported safely.')
      }
      cookies.push(transformed)
    }
  }
  return cookies
}

const personalBrowserForImport = async (
  deps: CloudBrowserDeps,
  input: { agentId: string; agentOwnerUserId: string | null; organizationId: string; userId: string },
): Promise<PersonalBrowser> => {
  const agentBrowser = await ensureAgentBrowser(deps, {
    agentId: input.agentId,
    agentOwnerUserId: input.agentOwnerUserId,
    agentVisibility: 'private',
    organizationId: input.organizationId,
    principalUserId: input.userId,
  })
  const connection = await deps.prisma.cloudBrowserConnection.findFirst({
    where: {
      id: agentBrowser.connectionId,
      organizationId: input.organizationId,
      scope: 'user',
      status: 'active',
      userId: input.userId,
    },
    select: { apiKeyRef: true, id: true, projectId: true, scope: true },
  })
  if (!connection || agentBrowser.principalUserId !== input.userId) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION, 'This private browser belongs to another person.')
  }
  return {
    browserbaseContextId: agentBrowser.browserbaseContextId,
    connection,
    id: agentBrowser.id,
    principalUserId: agentBrowser.principalUserId,
    viewport: agentBrowser.viewport,
  }
}

/**
 * Copies only cookies that apply to selected HTTPS hosts into a person's
 * durable agent context. Domain cookies are narrowed to host-only copies;
 * their source scope is never replayed to a sibling site.
 */
export const importBrowserCookies = async (deps: CloudBrowserDeps, input: {
  agentId: string
  agentOwnerUserId: string | null
  cookies: Array<{ cookies: ImportedBrowserCookie[]; origin: string }>
  expiresAt: Date
  organizationId: string
  threadId: string
  userId: string
}): Promise<void> => {
  if (input.cookies.length === 0) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Choose at least one site to import.')
  }
  const cdpCookies = prepareImportedCookies(input.cookies)
  const browser = await personalBrowserForImport(deps, input)
  const selectedSites = input.cookies.map(({ origin }) => new URL(origin).hostname).join(', ')
  // This must precede session admission: the tracked session is authenticated
  // from its first allocation, including if the provider result is unknown.
  await recordAgentBrowserLogin(deps.prisma, {
    agentBrowserId: browser.id,
    organizationId: input.organizationId,
    serviceHint: `Chrome import approved for ${selectedSites}`,
    userId: input.userId,
  })

  let session: Awaited<ReturnType<typeof openPersonalBrowserAccessSession>> | null = null
  let cdp: CdpClient | null = null
  let writeAttempted = false
  try {
    session = await openPersonalBrowserAccessSession(deps, {
      agentBrowser: browser,
      agentId: input.agentId,
      expiresAt: input.expiresAt,
      organizationId: input.organizationId,
      threadId: input.threadId,
      userId: input.userId,
    })
    cdp = await (deps.connect ?? connectCdp)(session.connectUrl)
    writeAttempted = true
    // Storage.setCookies is defined for the browser endpoint. Unlike a
    // page-scoped Network call it does not require a target attachment, so the
    // selected-site jar is written before any page navigation or observation.
    await cdp.call('Storage.setCookies', { cookies: cdpCookies }, { sessionId: null })
  } catch (error) {
    if (writeAttempted) {
      throw new CloudBrowserUnknownOutcomeError('The selected-site cookies may have been accepted before the browser disconnected.')
    }
    throw error
  } finally {
    cdp?.close()
    if (session) {
      const released = await releaseCloudBrowserSession(deps, {
        releasedBy: 'browser_cookie_import',
        sessionId: session.sessionId,
        skipCapture: true,
      })
      if (!released) {
        throw new CloudBrowserUnknownOutcomeError('The selected-site import may have completed, but its browser session could not be confirmed closed.')
      }
    }
  }
}
