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
  encryptionSecret: string
  /** Test seam, the `SessionPoolDeps.connect` shape. */
  connect?: (connectUrl: string) => Promise<CdpClient>
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
export const resumeAgentBrowser = async (
  deps: CloudBrowserDeps,
  input: ResumeAgentBrowserInput,
): Promise<{ sessionId: string; restoredTabs: number }> => {
  const browser = await ensureAgentBrowser(deps, {
    organizationId: input.organizationId,
    agentId: input.agentId,
    agentVisibility: input.agentVisibility,
    agentOwnerUserId: input.agentOwnerUserId,
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
    encryptionSecret: input.encryptionSecret,
    // The worker's gate shape (`origin-gate.ts`), starting from what the
    // browser is being put back on. No agent drives this session, so nothing
    // reads it for a write decision; it is here so the row is well-formed for
    // anyone who does.
    originGate: {
      authenticatedOrigins: [],
      touchedAuthenticated: false,
      currentUrl: tabs[0]?.url ?? null,
    },
    agentBrowser: {
      id: browser.id,
      connectionId: browser.connectionId,
      browserbaseContextId: browser.browserbaseContextId,
      hasLogins: browser.loginCount > 0,
    },
  })

  if (tabs.length === 0) return { sessionId: opened.sessionId, restoredTabs: 0 }

  // The restore holds the socket only long enough to issue the navigations.
  // Nothing else drives this session, so there is no rival connection to
  // worry about — and a session that cannot be reached is released rather
  // than left billing behind a column that shows nothing.
  const dial = input.connect ?? connectCdp
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
    }).catch(() => undefined)
    throw error
  } finally {
    cdp?.close()
  }
}
