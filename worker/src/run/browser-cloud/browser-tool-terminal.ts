import {
  findLiveSessionForRun,
  releaseCloudBrowserSession,
  revokePersonalBrowserAccessGrant,
  type CloudBrowserDeps,
} from '@nessie/browser-cloud'

import { requestBrowserLogin } from './login-request.js'
import { captureTabsNow } from './tab-capture.js'
import { releaseCdp } from './session-pool.js'
import type { BrowserToolContext, BrowserToolOutcome } from './browser-tool-access.js'

export const runClose = async (
  deps: CloudBrowserDeps,
  context: BrowserToolContext,
): Promise<BrowserToolOutcome> => {
  const session = await findLiveSessionForRun(deps.prisma, context.run.id)
  if (!session) return { output: 'No browser is open.', success: true }
  // A temporary grant must never enumerate or persist its other tabs.
  const temporaryGrant = await deps.prisma.browserPersonalAccessGrant.findUnique({
    where: { sessionId: session.id }, select: { id: true },
  })
  if (!temporaryGrant) await captureTabsNow(deps, session.id)
  releaseCdp(session.id)
  const released = temporaryGrant
    ? await revokePersonalBrowserAccessGrant(deps, {
      grantId: temporaryGrant.id,
      releasedBy: 'tool',
    })
    : await releaseCloudBrowserSession(deps, { sessionId: session.id, releasedBy: 'tool' })
  return {
    output: released
      ? 'Browser closed.'
      : 'The browser was closed, but the provider did not confirm it stopped. '
        + 'It will be reaped automatically.',
    success: true,
  }
}

export const runLoginRequest = async (
  deps: CloudBrowserDeps,
  context: BrowserToolContext,
  args: Record<string, unknown>,
): Promise<BrowserToolOutcome & { cardId?: string }> => {
  const service = typeof args.service === 'string' ? args.service.trim() : ''
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  const origins = Array.isArray(args.origins) && args.origins.every((origin) => typeof origin === 'string')
    ? args.origins as string[]
    : []
  if (!service || !reason || origins.length === 0) {
    return {
      output: 'browser_login_request needs a service, reason, and exact HTTPS origins.',
      success: false,
    }
  }
  return requestBrowserLogin(deps, context, { origins, reason, service })
}

