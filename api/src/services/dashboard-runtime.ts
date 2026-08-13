/**
 * Binds the dashboard services to this deployment's real resources: the
 * encrypted secret store, the egress deny-list, and the file chokepoint.
 *
 * Kept apart from the services so they stay testable with fakes, and so the
 * three bindings that carry security weight are visible in one short file
 * rather than scattered through handlers.
 */

import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { createPgSecretStore, createPgSecretResolver } from '@nessie/mcp-manage'
import { DASHBOARD_MAX_DATASET_BYTES } from '@nessie/schemas'
import type { DashboardEgressPolicy } from '@nessie/dashboard'
import type { CredentialStore } from './dashboard-sources.js'

/**
 * Reuses the existing AES-256-GCM store behind a distinct `secret_dashboard_`
 * prefix, so a dashboard credential is never interchangeable with an MCP OAuth
 * token even though both live in one table.
 *
 * `resolve` is intentionally the only read, it is server-side only, and no
 * route or tool exposes it — the value goes straight into an outbound header
 * and is never returned to a caller.
 */
export const createDashboardCredentialStore = (
  prisma: PrismaClient,
  encryptionSecret: string,
): CredentialStore => {
  const store = createPgSecretStore(prisma, encryptionSecret, {
    refPrefix: 'secret_dashboard_',
  })
  const resolver = createPgSecretResolver(prisma, encryptionSecret)

  return {
    put: async (_organizationId, plaintext) => store.put({ accessToken: plaintext }),
    resolve: async (ref) => {
      if (!ref.startsWith('secret_dashboard_')) return null
      return resolver.resolve(ref)
    },
    delete: async (ref) => {
      await prisma.mcpOAuthSecret.deleteMany({ where: { ref } }).catch(() => undefined)
    },
  }
}

/**
 * Origins a dashboard may never fetch.
 *
 * Nessie's own API and admin origins are denied even though they are publicly
 * routable: the SSRF guard stops private addresses, but nothing stops a
 * perfectly ordinary HTTPS request to our own REST surface, and that request
 * would carry a source's credential rather than the viewer's — a confused
 * deputy against ourselves.
 */
export const buildDashboardEgressPolicy = (config: {
  apiPublicUrl?: string | null
  adminPublicUrl?: string | null
  webPublicUrl?: string | null
}): DashboardEgressPolicy => ({
  deniedOrigins: [config.apiPublicUrl, config.adminPublicUrl, config.webPublicUrl].filter(
    (value): value is string => Boolean(value),
  ),
})

/**
 * Reads a stored dataset blob back through the FileService chokepoint.
 *
 * The size cap is applied again on read: the blob was capped when written, but
 * this is the boundary where bytes become a parsed object in the API process,
 * and a stored file is untrusted input like any other.
 */
export const createDashboardDatasetLoader = (
  fileService: FileService,
  organizationId: string,
) => async (attachmentId: string): Promise<unknown> => {
  const opened = await fileService.openStream(attachmentId, organizationId)
  if (!opened) return null

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of opened.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > DASHBOARD_MAX_DATASET_BYTES) {
      opened.stream.destroy()
      throw new Error('stored dataset exceeds the size cap')
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
