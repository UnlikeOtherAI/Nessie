import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CredentialStore } from '@nessie/dashboard'

import { isCloudBrowserError } from '@nessie/browser-cloud'
import { createMcpSecretResolver } from '@nessie/mcp-manage'

import { sendApiError } from '../lib/api.js'
import { registerBrowserCloudAgentRoutes } from './browser-cloud-agent.js'
import { registerBrowserCloudAgentSessionRoutes } from './browser-cloud-agent-session.js'
import { registerBrowserCloudCanvasRoutes } from './browser-cloud-canvas.js'
import { registerBrowserCloudConnectionRoutes } from './browser-cloud-connections.js'
import { registerBrowserCloudControlRoutes } from './browser-cloud-controls.js'
import {
  createBrowserSessionOperations,
} from './browser-cloud-session-operations.js'
import { registerBrowserCloudViewerRoutes } from './browser-cloud-viewer.js'
import type { RouteDeps } from './types.js'


/**
 * Cloud browser connections and the watch surface.
 *
 * Scope is decided by which route accepted the key — the owner gate on an
 * organization connect, the caller's own identity on a personal one — never
 * by anything about the key itself.
 */

/**
 * Which browser row belongs to this caller, for this agent.
 *
 * A system-managed agent keeps one browser per person, so the caller's own is
 * the only one they may ever reach; an ordinary agent has one shared with its
 * team, where the principal is null. Every read of an agent's browser goes
 * through this, so no route can accidentally hand somebody a colleague's jar.
 */
export {
  browserSessionIsShared,
  viewerMaySeeCloudBrowserSession,
} from './browser-cloud-access.js'

const sendCloudBrowserError = (reply: FastifyReply, error: unknown): boolean => {
  if (!isCloudBrowserError(error)) return false
  const status =
    error.code === 'CLOUD_BROWSER_NO_CONNECTION' ? 404
    : error.code === 'CLOUD_BROWSER_AUTH_FAILED' ? 400
    : error.code === 'CLOUD_BROWSER_CAPACITY' ? 409
    : error.code === 'CLOUD_BROWSER_UNTRUSTED_ENDPOINT' ? 502
    : error.code === 'CLOUD_BROWSER_UNREACHABLE' ? 502
    : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}


export const registerBrowserCloudRoutes = (
  app: FastifyInstance,
  deps: RouteDeps & { dashboardCredentials: CredentialStore },
): void => {
  registerBrowserCloudCanvasRoutes(app, deps)
  const { prisma, encryptionKeyRing } = deps

  const secretResolver = createMcpSecretResolver(prisma, encryptionKeyRing)

  registerBrowserCloudConnectionRoutes(app, deps)

  registerBrowserCloudViewerRoutes(app, deps)

  const operations = createBrowserSessionOperations(prisma)

  registerBrowserCloudAgentSessionRoutes(app, {
    deps,
    operations,
    secretResolver,
    sendCloudBrowserError,
  })
  registerBrowserCloudAgentRoutes(app, { deps, sendCloudBrowserError })
  registerBrowserCloudControlRoutes(app, { deps, operations })

}
