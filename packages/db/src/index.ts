import { type Prisma, PrismaClient } from '@prisma/client'

export {
  buildCanonicalAuditPayload,
  computeEntryHash,
  stableStringify,
  verifyAuditChain,
  writeAuditEntry,
  writeAuditEntryInTransaction,
  type AuditActorType,
  type AuditChainVerification,
  type AuditEntryInput,
  type AuditOutcome,
} from './audit-chain.js'

export {
  enqueueOrchestrateDecide,
  enqueueQueueJob,
  enqueueRunExecution,
} from './queue.js'
export {
  buildAgentVisibilityWhere,
  buildOwnedAgentWhere,
  buildVisibleAgentWhere,
  listVisibleAgentIdsForUser,
  type AgentVisibilityScope,
  type VisibleAgentWhereInput,
} from './agent-visibility.js'
export {
  visibleKnowledgeSpaceWhere,
  type VisibleKnowledgeSpaceWhereInput,
} from './knowledge-space-visibility.js'
export { visibleUserAlertWhere } from './user-alerts.js'
export {
  withSweepLock,
  type SweepLockOptions,
  type SweepLockOutcome,
  type SweepLockPool,
} from './sweep-lock.js'

export {
  claimThreadRunOrPend,
  drainPendingThreadMessages,
  drainPendingThreadMessagesBestEffort,
  isThreadRunSlotBusy,
  sweepPendingThreadMessages,
  type ThreadRunClaimOutcome,
} from './thread-serialization.js'

// Single source of truth for the Prisma connection across api/, worker/, and the
// seed CLI. A module-scoped singleton means that when the worker runs embedded in
// the API process (local mode), both halves share ONE connection pool instead of
// each opening its own. Importing this module from anywhere in the process yields
// the same client instance.

export type DbClientOptions = {
  /**
   * Max Prisma connection-pool size. Appended to the connection string as
   * `connection_limit`; without it Prisma defaults to `num_cpus * 2 + 1`.
   */
  connectionLimit?: number
  /** Prisma log levels. Defaults to warnings + errors. */
  log?: Prisma.LogLevel[]
}

let client: PrismaClient | null = null

const withConnectionLimit = (url: string, limit: number): string => {
  const parsed = new URL(url)
  parsed.searchParams.set('connection_limit', String(limit))
  return parsed.toString()
}

export const getPrismaClient = (options: DbClientOptions = {}): PrismaClient => {
  if (client) {
    return client
  }

  const url = process.env.DATABASE_URL
  client = new PrismaClient({
    log: options.log ?? ['warn', 'error'],
    ...(url && options.connectionLimit
      ? { datasources: { db: { url: withConnectionLimit(url, options.connectionLimit) } } }
      : {}),
  })
  return client
}

export const disconnectPrismaClient = async (): Promise<void> => {
  if (client) {
    await client.$disconnect()
    client = null
  }
}
