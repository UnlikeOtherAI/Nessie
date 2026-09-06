import { connectCdp, type CdpClient } from './cdp-client.js'
import { ensureAgentBrowser } from './agent-browser.js'
import { listAgentBrowserTabs, restoreBrowserTabs } from './agent-browser-tabs.js'
import {
  openCloudBrowserSession,
  releaseCloudBrowserSession,
  type CloudBrowserDeps,
} from './session-lifecycle.js'

export type ResumeAgentBrowserInput = {
  organizationId: string
  agentId: string
  agentVisibility: 'team' | 'private'
  agentOwnerUserId: string | null
  threadId: string
  teamId: string | null
  /** The person resuming. Never null: a resume is somebody's ask. */
  userId: string
  /**
   * Where to land when the browser has no stored tabs — a brand new one, or
   * one that was reset. Resolved by the caller through the settings cascade,
   * because that resolution belongs to the organisation's configuration and
   * not to this package, which must stay reachable from the worker with no
   * settings reader attached. Absent means "leave it on a blank page", which
   * is what a caller with no opinion gets.
   */
  homepage?: string
}

/**
 * Bring the agent's browser back the way it was left, for a person.
 *
 * Sign-ins were never lost — the durable browser is a persistent Browserbase
 * context — so what a resume restores is the *tabs*: a fresh session on that
 * context, each stored address opened again, the first in the page the
 * agent's verbs drive. The session has no run, so it lives on the idle TTL
 * (`session-lifecycle.ts`) and bills the connection the agent's browser
 * already lives on — a resume never spends an account the agent would not.
 *
 * The one-live-session-per-browser rule applies: while a person has it
 * resumed, the agent's own `browser_open` is told the browser is open in
 * another run, exactly as when two runs collide.
 */
/**
 * Best effort, deliberately: see the call site. A browser that came up but did
 * not reach its home page is still a working browser, and releasing it would
 * turn a cosmetic miss into a resume that failed.
 */
const openHomepage = async (
  deps: CloudBrowserDeps,
  connectUrl: string,
  homepage: string,
): Promise<void> => {
  const dial = deps.connect ?? connectCdp
  let cdp: CdpClient | null = null
  try {
    cdp = await dial(connectUrl)
    await cdp.attachToPage()
    await cdp.call('Page.navigate', { url: homepage })
  } catch {
    // Left on a blank page, which the reader can see and act on.
  } finally {
    cdp?.close()
  }
}

export const resumeAgentBrowser = async (
  deps: CloudBrowserDeps,
  input: ResumeAgentBrowserInput,
): Promise<{ sessionId: string; restoredTabs: number }> => {
  const browser = await ensureAgentBrowser(deps, {
    organizationId: input.organizationId,
    agentId: input.agentId,
    agentVisibility: input.agentVisibility,
    agentOwnerUserId: input.agentOwnerUserId,
    // A resume is somebody's own ask, so for an agent that keeps a browser per
    // person it is their jar that comes back — never a colleague's.
    principalUserId: input.userId,
  })
  const tabs = await listAgentBrowserTabs(deps.prisma, {
    organizationId: input.organizationId,
    agentBrowserId: browser.id,
  })

  const opened = await openCloudBrowserSession(deps, {
    organizationId: input.organizationId,
    runId: null,
    threadId: input.threadId,
    agentId: input.agentId,
    requestedByUserId: input.userId,
    teamId: input.teamId,
    encryptionSecret: deps.encryptionSecret ?? '',
    // The worker's gate shape (`origin-gate.ts`), starting from what the
    // browser is being put back on. No agent drives this session, so nothing
    // reads it for a write decision; it is here so the row is well-formed for
    // anyone who does.
    originGate: {
      authenticatedOrigins: [],
      touchedAuthenticated: false,
      currentUrl: tabs[0]?.url ?? input.homepage ?? null,
    },
    agentBrowser: {
      id: browser.id,
      connectionId: browser.connectionId,
      browserbaseContextId: browser.browserbaseContextId,
      hasLogins: browser.loginCount > 0,
      // The same window the agent's own runs get, so a person resuming sees
      // the pages laid out the way the agent left them rather than reflowed.
      viewport: browser.viewport,
    },
  })

  if (tabs.length === 0) {
    // Nothing to put back, so this is a browser opening for the first time.
    // Landing it on the home page rather than a blank page is the difference
    // between a window somebody can use and one they have to type an address
    // into — and unlike a restore, failing to get there is not worth ending
    // the session over: the browser is up, it is simply still blank.
    if (input.homepage !== undefined) {
      await openHomepage(deps, opened.connectUrl, input.homepage)
    }
    return { sessionId: opened.sessionId, restoredTabs: 0 }
  }

  // The restore holds the socket only long enough to issue the navigations.
  // Nothing else drives this session, so there is no rival connection to
  // worry about — and a session that cannot be reached is released rather
  // than left billing behind a column that shows nothing.
  const dial = deps.connect ?? connectCdp
  let cdp: CdpClient | null = null
  try {
    cdp = await dial(opened.connectUrl)
    await cdp.attachToPage()
    const restoredTabs = await restoreBrowserTabs(cdp, tabs)
    return { sessionId: opened.sessionId, restoredTabs }
  } catch (error) {
    await releaseCloudBrowserSession(deps, {
      sessionId: opened.sessionId,
      releasedBy: 'resume_failed',
      // Nothing was restored, so there is no last state worth a dial.
      skipCapture: true,
    }).catch(() => undefined)
    throw error
  } finally {
    cdp?.close()
  }
}
