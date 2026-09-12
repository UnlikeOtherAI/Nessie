import { loadConfig } from '@nessie/config'
import { type CloudBrowserDeps } from '@nessie/browser-cloud'
import {
  createDeepSignalMcpIdentityServiceFromEnv,
  createFileService,
  createLedgerIdentityServiceFromEnv,
  createModelClient,
  createPgPool,
  PgQueueProvider,
  PgRealtimeTransport,
  type EncryptionKeyRingInput,
} from '@nessie/runtime'
import { getPrismaClient } from '@nessie/db'
import { createSubscriptionSecretStoreFromEnv } from '@nessie/model-subscriptions'
import { executeRunJob } from './run/execute.js'

export type WorkerConfig = ReturnType<typeof loadConfig>
type RunDependencies = Parameters<typeof executeRunJob>[0]

export type WorkerCoreSubscriptionDeps = {
  abortSignal: AbortSignal
  cloudBrowser: CloudBrowserDeps
  config: WorkerConfig
  deepSignalMcpIdentity: ReturnType<typeof createDeepSignalMcpIdentityServiceFromEnv>
  encryptionKeyRing: EncryptionKeyRingInput
  fileService: ReturnType<typeof createFileService>
  ledgerIdentity: ReturnType<typeof createLedgerIdentityServiceFromEnv>
  mcpSecrets: RunDependencies['mcpSecrets']
  modelClient: ReturnType<typeof createModelClient>
  pool: ReturnType<typeof createPgPool>
  prisma: ReturnType<typeof getPrismaClient>
  queueProvider: PgQueueProvider
  realtimeTransport: PgRealtimeTransport
  runnerLabelPrefix: string
  subscribe: PgQueueProvider['subscribe']
  subscriptionSecrets: ReturnType<typeof createSubscriptionSecretStoreFromEnv>
}

export type WorkerIntegrationSubscriptionDeps = Pick<
  WorkerCoreSubscriptionDeps,
  'abortSignal' | 'config' | 'encryptionKeyRing' | 'fileService' | 'prisma' | 'realtimeTransport' | 'runnerLabelPrefix' | 'subscribe'
>

export type WorkerSweepDeps = Pick<
  WorkerCoreSubscriptionDeps,
  'abortSignal' | 'cloudBrowser' | 'encryptionKeyRing' | 'pool' | 'prisma' | 'realtimeTransport' | 'runnerLabelPrefix'
> & { automaticMembershipEnabled: boolean }
