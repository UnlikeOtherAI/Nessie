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
  adoptHandedBackSession,
  claimSessionControl,
  CONTROL_CLAIM_TTL_MS,
  expireStaleControlClaims,
  hasActiveSessionControlClaim,
  releaseSessionControl,
  userMayClaimCloudBrowserSessionControl,
  cloudBrowserSettings,
  findLiveSessionForRun,
  BLOCKING_SESSION_STATUSES,
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
  withCloudBrowserSessionControlLock,
} from './session-lifecycle.js'

export {
  connectCloudBrowser,
  describeConnectError,
  disconnectCloudBrowser,
  listCloudBrowserConnections,
  persistCloudBrowserConnection,
  probeCloudBrowserConnection,
  validateCloudBrowserConnectionInput,
  type CloudBrowserConnectionPersistenceDeps,
  type CloudBrowserConnectionProbeDeps,
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
  ensureAgentBrowser,
  reconcileTombstonedAgentBrowsers,
  resetAgentBrowser,
  resolveDurableBrowserConnection,
  type AgentBrowserRow,
} from './agent-browser.js'

export {
  agentBrowserLoginStatus,
  describeAgentBrowser,
  loadAgentBrowserLoginStatus,
  recordAgentBrowserLogin,
  viewerMaySeeAgentBrowser,
  type AgentBrowserLoginStatus,
} from './agent-browser-access.js'

export {
  AGENT_BROWSER_TAB_LIMIT,
  CAPTURE_TIMEOUT_MS,
  captureSessionTabs,
  captureTabsAtConnectUrl,
  captureUndrivenSessionTabs,
  listAgentBrowserTabs,
  persistAgentBrowserTabs,
  restoreBrowserTabs,
  SCREENSHOT_MAX_BYTES,
  snapshotBrowserTabs,
  type AgentBrowserTabRecord,
  type CapturedTab,
} from './agent-browser-tabs.js'

export { resumeAgentBrowser, type ResumeAgentBrowserInput } from './resume.js'

export {
  isPrivateBrowserHome,
  type PrivateBrowserHome,
  type PrivateBrowserHomeDatabase,
} from './private-browser-home.js'

export {
  importBrowserCookies,
  prepareImportedCookies,
  type ImportedBrowserCookie,
} from './cookie-import.js'

export {
  activatePersonalBrowserAccessGrant,
  adoptPersonalBrowserAccessGrant,
  createPersonalBrowserAccessGrant,
  hasPendingPersonalBrowserAccess,
  loadActivePersonalBrowserAccessForRun,
  normalizePersonalBrowserOrigins,
  openPersonalBrowserAccessSession,
  revokePersonalBrowserAccessForRun,
  revokePersonalBrowserAccessGrant,
  PERSONAL_BROWSER_ACCESS_MAX_MS,
  personalBrowserGrantAllowsOrigin,
  validatePersonalBrowserAccess,
  type PersonalBrowser,
} from './personal-access-grant.js'
