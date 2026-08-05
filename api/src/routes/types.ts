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
}
