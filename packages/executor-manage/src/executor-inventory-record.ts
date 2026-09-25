import { ExecutorScopeSchema, ExecutorPlatformFactsSchema } from '@nessie/schemas'
import type { ExecutorPlatformFacts, ExecutorProfile, ExecutorScope } from '@nessie/schemas'

type ExecutorRow = {
  teamAccess?: { everyone: boolean } | null
  _count?: { projectAccess: number }
  id: string
  organizationId: string
  projectId: string | null
  scopeKind: 'private' | 'project' | 'organization'
  pairingOwnerUserId: string
  label: string
  profiles: ExecutorProfile[]
  platformFacts: unknown
  machineKeyFingerprint: string | null
  status: 'pending_pairing' | 'online' | 'offline' | 'paused' | 'draining' | 'revoked' | 'error'
  authorizationRevision: number
  lastSeenAt: Date | null
  statusDetail: string | null
  createdAt: Date
  updatedAt: Date
}

export type ExecutorRecord = {
  sharedWithTeam?: boolean
  id: string
  scope: ExecutorScope
  label: string
  profiles: ExecutorProfile[]
  /** Read-only host facts the daemon stated under its own signature. */
  platformFacts?: ExecutorPlatformFacts
  machineKeyFingerprint?: string
  status: ExecutorRow['status']
  authorizationRevision: number
  lastSeenAt?: string
  statusDetail?: string
  createdAt: string
  updatedAt: string
}

// A row written before the platform contract widened states no supervisor or
// sandbox backend, so it reads as absent rather than half-guessed; the daemon
// replaces it with its next proposed revision.
const platformFactsFor = (stored: unknown): { platformFacts?: ExecutorPlatformFacts } => {
  const parsed = ExecutorPlatformFactsSchema.safeParse(stored)
  return parsed.success ? { platformFacts: parsed.data } : {}
}

export const recordFromRow = (row: ExecutorRow): ExecutorRecord => ({
  id: row.id,
  sharedWithTeam: Boolean(row.teamAccess?.everyone || row._count?.projectAccess),
  scope: ExecutorScopeSchema.parse(row.scopeKind === 'project'
    ? { kind: 'project', organizationId: row.organizationId, projectId: row.projectId! }
    : { kind: row.scopeKind, organizationId: row.organizationId }),
  label: row.label,
  profiles: row.profiles,
  ...platformFactsFor(row.platformFacts),
  ...(row.machineKeyFingerprint ? { machineKeyFingerprint: row.machineKeyFingerprint } : {}),
  status: row.status,
  authorizationRevision: row.authorizationRevision,
  ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt.toISOString() } : {}),
  ...(row.statusDetail ? { statusDetail: row.statusDetail } : {}),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})
