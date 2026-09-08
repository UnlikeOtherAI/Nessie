import type { PrismaClient } from '@prisma/client'

import {
  agentBrowserLoginStatus,
  CLOUD_BROWSER_ERROR_CODES,
  CloudBrowserError,
  CloudBrowserUnknownOutcomeError,
  currentPageUrl,
  findLiveSessionForRun,
  isCloudBrowserError,
  personalBrowserGrantAllowsOrigin,
  type CloudBrowserDeps,
  validatePersonalBrowserAccess,
  withCloudBrowserSessionControlLock,
} from '@nessie/browser-cloud'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

import { acquireCdp, type SessionPoolDeps } from './session-pool.js'

export type BrowserToolOutcome = { output: string; success: boolean; cardId?: string }

export type BrowserToolContext = BuiltinToolRuntimeContext & {
  cloudBrowser?: CloudBrowserDeps
  agentIdentity?: { visibility: 'team' | 'private'; ownerUserId: string | null }
}

export const browserDisclosureScope = (
  agentId: string,
  principalUserId: string | null,
): { scopeId: string; scopeType: 'agent' | 'user' } =>
  principalUserId
    ? { scopeId: principalUserId, scopeType: 'user' }
    : { scopeId: agentId, scopeType: 'agent' }

export const recordBrowserDisclosure = (
  context: BrowserToolContext,
  principalUserId: string | null,
): void => {
  if (!context.consumedSources) {
    throw new Error('A browser read requires the run disclosure source sink.')
  }
  context.consumedSources.add(browserDisclosureScope(context.agentId, principalUserId))
}

export const poolFor = (deps: CloudBrowserDeps): SessionPoolDeps => ({ prisma: deps.prisma })

export const unavailable: BrowserToolOutcome = {
  output: 'Cloud browsing is not configured on this deployment. Connect a Browserbase account in team settings first.',
  success: false,
}

export const liveSession = async (
  deps: CloudBrowserDeps,
  context: BrowserToolContext,
  toolId: string,
): Promise<
  | { ok: true; personalOrigins: string[] | null; sessionId: string }
  | { ok: false; result: BrowserToolOutcome }
> => {
  const session = await findLiveSessionForRun(deps.prisma, context.run.id)
  if (!session) {
    return { ok: false, result: { output: 'No browser is open. Call browser_open first.', success: false } }
  }
  if (session.controlledByUserId) {
    return { ok: false, result: deniedForControl('a person took control') }
  }
  if (session.agentBrowser && !agentBrowserLoginStatus({
    loginCount: session.agentBrowser._count.logins,
    principalUserId: session.agentBrowser.principalUserId,
  }).permitsSensitiveUse) {
    return {
      ok: false,
      result: {
        output: 'This shared browser has a human sign-in without a private owner. Reset it before the agent can use it again.',
        success: false,
      },
    }
  }
  const personalGrant = await validatePersonalBrowserAccess(deps.prisma, {
    agentId: context.agentId,
    runId: context.run.id,
    sessionId: session.id,
    threadId: context.run.threadId,
    toolId,
  })
  if (personalGrant) recordBrowserDisclosure(context, personalGrant.userId)
  if (session.authenticated && !personalGrant) {
    recordBrowserDisclosure(context, session.agentBrowser?.principalUserId ?? null)
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    return {
      ok: false,
      result: { output: 'The browser session expired. Open a new one if you still need it.', success: false },
    }
  }
  return { ok: true, personalOrigins: personalGrant?.origins ?? null, sessionId: session.id }
}

export const withLockedLiveSession = async <T>(
  deps: CloudBrowserDeps,
  context: BrowserToolContext,
  toolId: string,
  sessionId: string,
  drive: (session: { personalOrigins: string[] | null; sessionId: string }) => Promise<T>,
): Promise<T | BrowserToolOutcome> =>
  withCloudBrowserSessionControlLock(deps.prisma, { sessionId }, async (tx) => {
    const fresh = await liveSession(
      { ...deps, prisma: tx as unknown as PrismaClient },
      context,
      toolId,
    )
    if (!fresh.ok) return fresh.result
    return drive(fresh)
  })

export const requireGrantedOrigin = async (
  cdp: Awaited<ReturnType<typeof acquireCdp>>,
  origins: string[] | null,
): Promise<void> => {
  if (!origins || !cdp) return
  const url = await currentPageUrl(cdp)
  if (!url || !personalBrowserGrantAllowsOrigin(origins, url)) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_SESSION,
      'The private browser left its approved sites. Ask for a new explicit site grant.',
    )
  }
}

/**
 * An observation is a browser read. Validate both the snapshot's reported URL
 * and the page after the snapshot, because a redirect can happen while CDP is
 * collecting the accessibility tree and screenshot.
 */
export const requireGrantedObservationOrigin = async (
  cdp: Awaited<ReturnType<typeof acquireCdp>>,
  origins: string[] | null,
  observationUrl: string,
): Promise<void> => {
  if (origins && !personalBrowserGrantAllowsOrigin(origins, observationUrl)) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_SESSION,
      'The private browser left its approved sites. Ask for a new explicit site grant.',
    )
  }
  await requireGrantedOrigin(cdp, origins)
}

/** Do not let a redirected observation reach a model-output renderer. */
export const observeWithinGrantedOrigin = async <T extends { url: string }>(
  cdp: Awaited<ReturnType<typeof acquireCdp>>,
  origins: string[] | null,
  observe: () => Promise<T>,
): Promise<T> => {
  const observation = await observe()
  await requireGrantedObservationOrigin(cdp, origins, observation.url)
  return observation
}

export const asToolFailure = (error: unknown, acting: boolean): BrowserToolOutcome => {
  if (isCloudBrowserError(error)) {
    const preAction = error.code === CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION
      || error.code === CLOUD_BROWSER_ERROR_CODES.NO_SESSION
      || error.code === CLOUD_BROWSER_ERROR_CODES.CAPACITY
      || error.code === CLOUD_BROWSER_ERROR_CODES.SESSION_ALREADY_OPEN
      || error.code === CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED
      || error.code === CLOUD_BROWSER_ERROR_CODES.EXPIRED
    if (preAction || !acting) return { output: error.message, success: false }
  }
  if (acting) throw new CloudBrowserUnknownOutcomeError()
  return { output: (error as Error).message, success: false }
}

const deniedForControl = (holder: string): BrowserToolOutcome => ({
  output: `Somebody is at the controls of this browser right now (${holder}). Wait for them to hand it back before acting.`,
  success: false,
})

export const mayUseSignedInBrowser = (input: {
  handedBackByUserId?: string | null
  interactive?: boolean
  loginCount: number
  originatingUserId?: string | null
  principalUserId: string | null
}): boolean => {
  if (input.loginCount <= 0) return true
  const forThisPerson = (userId: string | null | undefined): boolean =>
    input.principalUserId === null || userId === input.principalUserId
  if (input.handedBackByUserId && forThisPerson(input.handedBackByUserId)) return true
  return input.interactive === true && forThisPerson(input.originatingUserId)
}
