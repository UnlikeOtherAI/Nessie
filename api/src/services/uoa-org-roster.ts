import { Prisma, type PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import type { UoaProvisionedTeam } from '@nessie/team-admin'

import { forgetUoaTeamDirectory } from './uoa-directory-cache.js'

// The UOA team-roster seam lives in `@nessie/team-admin` so the
// personal assistant's `people_search` (worker) reads the same roster the
// Members page routes serve — the worker cannot import `api/src/services/*`.
// The routes keep importing it from here.
export {
  acceptTeamInvitation,
  checkUoaSlugAvailability,
  createUoaOrganisation,
  createUoaTeamTeam,
  createTeamInvitation,
  createTeamInvitations,
  addTeamMember,
  findTeamMemberCandidates,
  listTeamInvitations,
  listTeamMembers,
  removeTeamMember,
  resendTeamInvitation,
  resolveLocalUserIdsByUoaSub,
  resolveUoaTeamHost,
  resolveUoaRosterTeam,
  revokeTeamInvitation,
  reviewTeamInvitation,
  setTeamMemberActivation,
  updateTeamMemberRole,
  UoaInvitationOrgConflictError,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaProvisionedTeam,
  type UoaRosterDeps,
  type UoaRosterPrisma,
  type UoaRosterTeam,
  type TeamInvitationReview,
  type TeamMemberActivation,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from '@nessie/team-admin'

// The organisation and the team are UOA-owned objects too, not just the
// people in them: a rename of either is relayed, never stored locally as an
// independent value. Same seam, same package, same reason the roster lives
// there.
export { renameUoaOrganization, renameUoaTeam } from '@nessie/team-admin'

// The organisation-wide roster (every member, no team join) — distinct from
// `listTeamMembers` above, which is correctly team-scoped. An
// "Organization Members" surface must read these, never the team-scoped
// ones.
export {
  listMemberInvitationTargets,
  listOrganisationMemberInvitations,
  listOrganisationMembers,
  listOrganisationMemberTeamAccess,
  updateOrganisationMemberRole,
  withUoaOrgRosterSubjectAssertion,
} from '@nessie/team-admin'

/**
 * The idempotent-provisioning workflow that wraps `createUoaOrganisation` and
 * `createUoaTeamTeam` above: an advisory lock, an audit-log-as-ledger replay
 * check, and the transactional write. It lives beside the UOA-facing calls it
 * wraps rather than in the route file, because it is the mechanism that keeps
 * a double-submitted "create organisation" click from minting two.
 */

export type ProvisioningRequestMeta = {
  requestId: string
  ipAddress: string | null
  userAgent: string | null
}

/**
 * Serialize one person's provisioning attempts across every API replica.
 *
 * Transaction-scoped, matching `lockUserSessions` and the audit chain's own
 * lock. Two clicks a few milliseconds apart would otherwise both pass the
 * replay check below and create two organisations.
 */
export const lockUserProvisioning = async (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`nessie:org-provisioning:${userId}`}, 0)
    )
  `)
}

/**
 * The result of an earlier attempt carrying this idempotency key, if any.
 *
 * **The audit log is the ledger.** It already records who created what, it is
 * append-only and hash-chained, and using it means no second table mirroring
 * UOA's organisation ids — which is the whole point of this feature. Every
 * predicate but the JSON one is covered by an existing organisation-scoped
 * index (`audit_logs` carries several leading on `organization_id`), and the
 * 24-hour window bounds what is left, so only a handful of rows ever reach the
 * JSON comparison: no new index, and no walk of the organisation's history.
 */
export const findPriorProvisioning = async (
  tx: Prisma.TransactionClient,
  input: {
    action: string
    organizationId: string
    userId: string
    idempotencyKey: string
  },
): Promise<UoaProvisionedTeam | null> => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const prior = await tx.auditLog.findFirst({
    where: {
      organizationId: input.organizationId,
      action: input.action,
      actorId: input.userId,
      outcome: 'success',
      createdAt: { gte: since },
      metadata: { path: ['idempotencyKey'], equals: input.idempotencyKey },
    },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  })
  const metadata = prior?.metadata as Record<string, unknown> | null | undefined
  const externalOrgId = typeof metadata?.externalOrgId === 'string' ? metadata.externalOrgId : null
  const externalTeamId = typeof metadata?.externalTeamId === 'string' ? metadata.externalTeamId : null
  return externalOrgId && externalTeamId ? { externalOrgId, externalTeamId } : null
}

/**
 * Run one provisioning attempt exactly once per idempotency key.
 *
 * The UOA call happens INSIDE the interactive transaction, which is unusual
 * here and deliberate. Holding the per-user advisory lock across it is what
 * makes a double-submit impossible rather than merely unlikely, and the
 * alternative — a lock released before the call — leaves exactly the window
 * this exists to close. It is safe because the call is a single POST bounded by
 * the `/org/*` seam's own 10s timeout, well inside the transaction budget; the
 * long multi-step UOA exchanges that must stay outside transactions are a
 * different shape entirely.
 */
export const provisionOnce = async (
  prisma: PrismaClient,
  requestMeta: ProvisioningRequestMeta,
  input: {
    action: string
    organizationId: string
    userId: string
    idempotencyKey: string
    name: string
    slug?: string
    resourceType: string
  },
  create: () => Promise<UoaProvisionedTeam>,
): Promise<UoaProvisionedTeam> => prisma.$transaction(
  async (tx) => {
    await lockUserProvisioning(tx, input.userId)

    const prior = await findPriorProvisioning(tx, input)
    if (prior) return prior

    const team = await create()

    // The caller's cached team directory predates what they just made.
    // The switch that normally follows re-primes it, but if that call fails
    // they would otherwise be told their own new team does not exist for
    // up to the cache TTL.
    forgetUoaTeamDirectory(input.userId)

    await writeAuditEntryInTransaction(tx, {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: team.externalOrgId,
      outcome: 'success',
      metadata: {
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        slug: input.slug ?? null,
        externalOrgId: team.externalOrgId,
        externalTeamId: team.externalTeamId,
      },
      ...requestMeta,
    })

    return team
  },
  { maxWait: 5_000, timeout: 25_000 },
)
