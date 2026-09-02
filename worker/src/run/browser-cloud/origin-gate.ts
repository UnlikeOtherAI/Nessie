import type { CdpClient } from '@nessie/browser-cloud'

/**
 * The cross-origin write gate.
 *
 * The threat is not that a hostile page tells the agent something false — the
 * disclosure basis covers what gets published. It is that a hostile page tells
 * the agent to read the signed-in tab and *type what it finds somewhere else*,
 * which leaves through the browser's own egress and never touches a Nessie
 * message at all.
 *
 * So reads stay completely unrestricted — narrowing them would kill the
 * capability — and the gate sits on writes to a *foreign* origin once the
 * session has touched an authenticated one. Origins are structural facts, not
 * a judgement about content.
 *
 * What it deliberately does not catch, stated so nobody mistakes it for a
 * boundary it is not: page scripts (CSRF, redirects, popups) act below the
 * tool layer; and material carried across runs in the model's own memory can
 * be typed anywhere by a later clean session — the generic
 * model-knows-a-secret problem, shared with `http_fetch`, not new here.
 */

export type OriginGateState = {
  /** Origins whose cookies were present when the browser opened. */
  authenticatedOrigins: Set<string>
  /** Whether this session has actually loaded one of them. */
  touchedAuthenticated: boolean
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Read the authenticated origin set from the browser itself.
 *
 * Cookie domains rather than `serviceHint`: the hint is display text a person
 * typed, and a gate keyed on it would be trivially wrong in both directions.
 */
export const readAuthenticatedOrigins = async (cdp: CdpClient): Promise<Set<string>> => {
  const origins = new Set<string>()
  try {
    const result = await cdp.call('Network.getAllCookies', {})
    const cookies = Array.isArray(result.cookies) ? result.cookies : []
    for (const entry of cookies) {
      const cookie = entry as { domain?: unknown; secure?: unknown }
      if (typeof cookie.domain !== 'string' || cookie.domain.length === 0) continue
      const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
      // A session cookie on a host is the mechanical trace of a sign-in there.
      origins.add(`https://${host}`)
    }
  } catch {
    // A browser that cannot enumerate cookies gates nothing extra; the
    // session-level `authenticated` flag still drives disclosure.
  }
  return origins
}

/** Does this origin belong to a host we hold cookies for, or a subdomain of one? */
export const originIsAuthenticated = (
  origin: string,
  authenticated: ReadonlySet<string>,
): boolean => {
  if (authenticated.has(origin)) return true
  const host = originOf(origin)?.replace(/^https?:\/\//, '')
  if (!host) return false
  for (const known of authenticated) {
    const knownHost = known.replace(/^https?:\/\//, '')
    if (host === knownHost || host.endsWith(`.${knownHost}`)) return true
  }
  return false
}

export type BrowserWriteAction =
  | { action: 'navigate'; url: string }
  | { action: 'click'; nodeId: number }
  | { action: 'type'; nodeId: number; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; nodeId?: number; deltaY: number }

/**
 * Typing and clicking are writes; scrolling and key presses that only move
 * focus are not. `navigate` is a read — going somewhere is how browsing works,
 * and the decision was explicitly not to narrow what the agent may look at.
 */
const isWrite = (action: BrowserWriteAction): boolean =>
  action.action === 'type' || action.action === 'click'

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: string }

export const evaluateOriginGate = (
  state: OriginGateState,
  currentUrl: string,
  action: BrowserWriteAction,
): GateVerdict => {
  // Nothing signed in, or nothing signed-in visited yet: ordinary browsing.
  if (!state.touchedAuthenticated) return { allowed: true }
  if (!isWrite(action)) return { allowed: true }

  const origin = originOf(currentUrl)
  if (!origin) return { allowed: true }
  if (originIsAuthenticated(origin, state.authenticatedOrigins)) return { allowed: true }

  return {
    allowed: false,
    reason:
      `This browser is signed in to other sites, and ${origin} is not one of them. `
      + 'Entering text or clicking here could send that private information '
      + 'somewhere it should not go, so it is blocked. If this is genuinely part '
      + 'of the task, ask the person to take control of the browser and do it '
      + 'themselves.',
  }
}

/** Track that the session has actually loaded an authenticated origin. */
export const noteVisitedOrigin = (state: OriginGateState, url: string): void => {
  const origin = originOf(url)
  if (!origin) return
  if (originIsAuthenticated(origin, state.authenticatedOrigins)) {
    state.touchedAuthenticated = true
  }
}
