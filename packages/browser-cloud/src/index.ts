export {
  CLOUD_BROWSER_ERROR_CODES,
  CloudBrowserError,
  CloudBrowserUnknownOutcomeError,
  isCloudBrowserError,
  type CloudBrowserErrorCode,
} from './errors.js'

export {
  assertBrowserbaseUrl,
  createBrowserbaseClient,
  isBrowserbaseHost,
  type BrowserbaseClient,
  type BrowserbaseCredentials,
  type BrowserbaseLiveView,
  type BrowserbaseSession,
  type CreateSessionInput,
} from './browserbase-client.js'

export { openPinnedWebSocket, type PinnedWebSocket } from './pinned-websocket.js'

export { connectCdp, type CdpClient } from './cdp-client.js'

export {
  actInBrowser,
  currentPageUrl,
  observeBrowser,
  renderObservation,
  type BrowserActResult,
  type BrowserObservation,
  type ObservedNode,
} from './browser-actions.js'

export {
  claimSessionControl,
  CONTROL_CLAIM_TTL_MS,
  expireStaleControlClaims,
  releaseSessionControl,
  cloudBrowserSettings,
  findLiveSessionForRun,
  LIVE_SESSION_STATUSES,
  markConnectionNeedsAttention,
  markSessionAuthenticated,
  openCloudBrowserSession,
  reapExpiredCloudBrowserSessions,
  releaseCloudBrowserSession,
  releaseSessionsForRun,
  resolveConnectionForRun,
  touchResumedSession,
  type CloudBrowserDeps,
  type LiveSessionRow,
  type OpenSessionInput,
  type OpenSessionResult,
  type ResolvedConnection,
} from './session-lifecycle.js'

export {
  connectCloudBrowser,
  describeConnectError,
  disconnectCloudBrowser,
  listCloudBrowserConnections,
  type ConnectCloudBrowserInput,
  type ConnectionDeps,
  type ConnectionScope,
  type ConnectionSummary,
} from './connection-management.js'

export {
  loadSessionCapability,
  persistOriginGate,
  sealConnectCapability,
  type PersistedSessionCapability,
} from './session-capability.js'

export {
  describeAgentBrowser,
  ensureAgentBrowser,
  recordAgentBrowserLogin,
  reconcileTombstonedAgentBrowsers,
  resetAgentBrowser,
  resolveDurableBrowserConnection,
  type AgentBrowserRow,
} from './agent-browser.js'

export {
  AGENT_BROWSER_TAB_LIMIT,
  captureSessionTabs,
  listAgentBrowserTabs,
  persistAgentBrowserTabs,
  restoreBrowserTabs,
  SCREENSHOT_MAX_BYTES,
  snapshotBrowserTabs,
  type AgentBrowserTabRecord,
  type CapturedTab,
} from './agent-browser-tabs.js'

export { resumeAgentBrowser, type ResumeAgentBrowserInput } from './resume.js'
