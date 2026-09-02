import type { SubscriptionSecretStore } from '@nessie/model-subscriptions'
import type { PrismaClient } from '@prisma/client'
import type {
  DeepSignalMcpIdentityService,
  FileService,
  LedgerIdentityService,
  ModelClient,
} from '@nessie/runtime'
import type { CaptureConfig } from '@nessie/memory'
import type { createRealtimeHub } from '../realtime/hub.js'
import type { createThoughtService } from '../services/thoughts.js'
import type { SecretStore } from '@nessie/mcp-manage'
import type { ServerContext } from '../lib/server-context.js'

export type RealtimeHub = Awaited<ReturnType<typeof createRealtimeHub>>

export type ThoughtService = ReturnType<typeof createThoughtService>

/**
 * Everything a per-domain route module needs. Constructed once in `buildApp`
 * from the shared `ServerContext` (config/prisma/auth helpers) plus the
 * resources created inside `buildApp` itself (realtime hub, model client,
 * memory/thought services). Each `register<Domain>Routes(app, deps)` closes over
 * exactly this object — replacing the implicit closures the handlers used while
 * inlined in `index.ts`. Behaviour is unchanged.
 */
export type RouteDeps = ServerContext & {
  prisma: PrismaClient
  realtimeHub: RealtimeHub
  sharedModelClient: ModelClient | null
  messageMemoryCaptureConfig: CaptureConfig | null
  thoughtService: ThoughtService | null
  ledgerIdentity: LedgerIdentityService | null
  deepSignalMcpIdentity: DeepSignalMcpIdentityService | null
  // Single chokepoint for all blob file work (store/stream/delete + accounting).
  fileService: FileService
  /**
   * Vault access for personal model subscriptions. Null when the deployment has
   * not configured the dedicated subscription vault project, which makes the
   * settings surface say so plainly rather than offer a link button that cannot
   * store anything.
   */
  subscriptionSecrets?: SubscriptionSecretStore | null
  /**
   * Encrypted store for user-provided connector credentials, minting
   * `secret_mcp_` refs. Shared with the instance-secret route so a secret
   * typed into an agent card lands exactly where one typed into the
   * connector UI does.
   */
  mcpSecretStore: SecretStore
}
