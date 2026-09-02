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
  observeBrowser,
  renderObservation,
  type BrowserActResult,
  type BrowserObservation,
  type ObservedNode,
} from './browser-actions.js'

export {
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
  type CloudBrowserDeps,
  type LiveSessionRow,
  type OpenSessionInput,
  type OpenSessionResult,
  type ResolvedConnection,
} from './session-lifecycle.js'
