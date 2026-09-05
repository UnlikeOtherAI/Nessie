import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

import { enqueueAutomaticMembershipProvisioning } from './automatic-membership/signin.js'
import { lockExternalOrganization } from './external-organization.js'
import { seedDefaultPolicies } from './policy.js'
import { syncProfileMirrorFromClaims } from './uoa-profile-mirror.js'
import { projectUoaRoles, type UoaRoleClaims } from './uoa-roles.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

// Local principal resolution for SSO logins. UOA principals are keyed by the
// stable UOA subject (`User.uoaSub`); email is only a one-time adoption bridge
// for rows created before the subject column existed (or seeded by the
// SSO-first bootstrap). Generic OIDC providers keep email keying unchanged.

export class UoaSubjectConflictError extends Error {
  constructor() {
    super(
      'This email address belongs to a Nessie account bound to a different '
      + 'UnlikeOtherAI identity. An operator must resolve the conflict before '
      + 'this sign-in can continue.',
    )
    this.name = 'UoaSubjectConflictError'
  }
}

export type PrincipalIdentityInput = {
  avatarUrl?: string
  // What the provider asserted, if anything. A row created without one is named
  // by its email address until the provider supplies a name — Nessie does not
  // manufacture one (see `identity-display.ts`).
  displayName?: string
  email: string
  uoaSub?: string
}

// A brand-new row still needs a value in the non-null column. The email address
// is the honest placeholder: it is what we actually know about the person.
const initialDisplayName = (input: PrincipalIdentityInput): string =>
  input.displayName?.trim() || input.email

/**
 * Read-only principal lookup: by stable subject first (UOA path), then by
 * email. Used for pre-transaction reads (default-target discovery, bootstrap
 * corruption checks); the authoritative resolve/adopt/create decision happens
 * under the advisory locks in `ensureTeamPrincipal`.
 */
export const findExistingPrincipal = async (
  reader: Pick<PrismaClient, 'user'> | Prisma.TransactionClient,
  input: { email: string; uoaSub?: string },
): Promise<{ id: string } | null> => {
  if (input.uoaSub) {
    const bySubject = await reader.user.findUnique({
      where: { uoaSub: input.uoaSub },
      select: { id: true },
    })
    if (bySubject) {
      return bySubject
    }
  }
  return reader.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
}

// Resolve-or-create the principal row. UOA path: subject first; on a miss, a
// ONE-TIME adoption claims an email row only while it is unbound
// (`uoaSub IS NULL`). An email row bound to a DIFFERENT subject fails the
// login closed — matching by email alone is the account-takeover vector
// documented in external-auth.ts, so the conflict is never resolved by taking
// the row over or by creating a duplicate (email stays unique).
const resolvePrincipalUser = async (
  transaction: Prisma.TransactionClient,
  input: PrincipalIdentityInput,
): Promise<{ id: string }> => {
  if (!input.uoaSub) {
    // Generic (non-UOA) OIDC providers: email keying, unchanged.
    const existing = await transaction.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    })
    return existing ?? transaction.user.create({
      data: {
        avatarUrl: input.avatarUrl,
        displayName: initialDisplayName(input),
        email: input.email,
      },
      select: { id: true },
    })
  }
  const bySubject = await transaction.user.findUnique({
    where: { uoaSub: input.uoaSub },
    select: { id: true },
  })
  if (bySubject) {
    return bySubject
  }
  const byEmail = await transaction.user.findUnique({
    where: { email: input.email },
    select: { id: true, uoaSub: true },
  })
  if (byEmail) {
    if (byEmail.uoaSub !== null) {
      throw new UoaSubjectConflictError()
    }
    // Adoption: claim the pre-subject row. Serialized by the subject + email
    // advisory locks held by the enclosing transaction, so no conditional
    // update is needed — no competing claim can interleave.
    await transaction.user.update({
      where: { id: byEmail.id },
      data: { uoaSub: input.uoaSub },
    })
    return { id: byEmail.id }
  }
  return transaction.user.create({
    data: {
      avatarUrl: input.avatarUrl,
      displayName: initialDisplayName(input),
      email: input.email,
      uoaSub: input.uoaSub,
    },
    select: { id: true },
  })
}

// Ensure a user has org/project/team/channel membership for a team. The
// upserts are create-only — they never resurrect a deactivated org membership
// or rewrite a role behind UOA's back. Role *changes* come from exactly one
// place afterwards: `projectUoaRoles`, replaying the verified claims, so a
// dimension UOA did not claim keeps whatever the row already held.
// Exported for the account-bound recovery transaction in team-context.ts,
// which writes memberships for an already-proven principal inside its own
// locked transaction.
export const ensureTeamMemberships = async (
  prisma: Prisma.TransactionClient,
  input: {
    userId: string
    organizationId: string
    projectId: string
    teamId: string
    channelId: string | null
    claims: UoaRoleClaims
    orgRole: MemberRole
    teamRole: MemberRole
  },
): Promise<void> => {
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
    update: {},
    create: { organizationId: input.organizationId, userId: input.userId, role: input.orgRole },
  })
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
    update: {},
    create: { projectId: input.projectId, userId: input.userId, role: input.teamRole },
  })
  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
    update: {},
    create: { teamId: input.teamId, userId: input.userId, role: input.teamRole },
  })
  if (input.channelId) {
    await prisma.channelMember.upsert({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      update: {},
      create: { channelId: input.channelId, userId: input.userId },
    })
  }
  await projectUoaRoles(prisma, {
    claims: input.claims,
    organizationId: input.organizationId,
    projectId: input.projectId,
    teamId: input.teamId,
    userId: input.userId,
  })
}

/**
 * First entry into a brand-new UOA organization: with no verified `org_role`
 * claim, the first materializer of the ORG becomes its owner — the exact
 * mirror of the first-materializer team rule, for the same reason (somebody
 * must be able to administer what was just created; a verified claim always
 * wins). Evaluated as "no organization member exists yet" under the
 * per-external-org advisory lock rather than as a created-this-call flag, so
 * an org row orphaned by a failed first login still gets an owner on the next
 * one. Exported for the account-bound recovery transaction, which holds the
 * same lock.
 */
export const isFirstOrganizationMember = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<boolean> =>
  (await tx.organizationMember.count({ where: { organizationId } })) === 0

// Read the user's org role after membership was ensured and UOA's claims were
// projected — the role the access token is scoped to. Exported for the
// account-bound recovery transaction in team-context.ts.
export const readOrgRole = async (
  prisma: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<MemberRole> => {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  })
  return member?.role ?? 'member'
}

const advisoryLock = (
  transaction: Prisma.TransactionClient,
  key: string,
): Prisma.PrismaPromise<unknown> => transaction.$queryRaw(Prisma.sql`
  SELECT 1
  FROM (
    SELECT pg_advisory_xact_lock(
      hashtextextended(${key}, 0)
    )
  ) AS acquired
`)

/**
 * UOA can complete the same principal's callback concurrently on multiple
 * devices. Serialize user creation and every membership write across replicas;
 * Prisma's upsert alone does not make concurrent create branches conflict-safe.
 */
export const ensureTeamPrincipal = async (
  prisma: PrismaClient,
  input: PrincipalIdentityInput & {
    channelId: string | null
    claims: UoaRoleClaims
    /**
     * The UOA organisation id when `organizationId` is a per-UOA-org
     * Organization (the 1:1 model). Enables the first-org-materializer owner
     * rule and default-policy seeding under the external-org advisory lock.
     * Absent on the legacy shared-org / generic-OIDC path, which keeps its
     * behaviour byte-for-byte.
     */
    externalOrgId?: string
    organizationId: string
    projectId: string
    teamId: string
    teamRole: MemberRole
  },
): Promise<{ id: string; orgRole: MemberRole }> => prisma.$transaction(async (transaction) => {
  // Lock order: external-org first (when this is a per-UOA-org login — the
  // first-member decision below must serialize org-wide), then the stable
  // subject — the principal key — then the email. Always in this order, so
  // the set cannot deadlock: the adoption path resolves and claims rows
  // through the unique `email` column, and non-UOA logins keep email keying
  // entirely, so two different subjects racing one email address — or a UOA
  // login racing a generic OIDC login for the same address — must meet on a
  // common lock rather than on the read-then-create window.
  if (input.externalOrgId) {
    await lockExternalOrganization(transaction, input.externalOrgId)
  }
  if (input.uoaSub) {
    await advisoryLock(transaction, `nessie:uoa-principal-sub:${input.uoaSub}`)
  }
  await advisoryLock(transaction, `nessie:uoa-principal:${input.email}`)
  const user = await resolvePrincipalUser(transaction, input)
  // The profile columns are a mirror of the provider's claims, not a Nessie
  // record: re-sync them from this exchange's verified assertions so a rename
  // or a new picture in UOA propagates instead of being frozen at provisioning.
  await syncProfileMirrorFromClaims(transaction, user.id, {
    avatarUrl: input.avatarUrl,
    displayName: input.displayName,
  })
  const firstOrgMember = input.externalOrgId
    ? await isFirstOrganizationMember(transaction, input.organizationId)
    : false
  await ensureTeamMemberships(transaction, {
    userId: user.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    teamId: input.teamId,
    channelId: input.channelId,
    claims: input.claims,
    // UOA's verified `org_role` decides the org membership. With no claim,
    // the first materializer of a brand-new UOA organization owns it (mirror
    // of the team rule); everyone else defaults to `member`.
    orgRole: input.claims.orgRole ?? (firstOrgMember ? 'owner' : 'member'),
    teamRole: input.teamRole,
  })
  if (firstOrgMember) {
    // A freshly materialized organization has no policy rules, and the engine
    // denies by default — seed the same defaults the bootstrap org gets, once,
    // attributed to the first member (idempotent; also self-healed at startup).
    await seedDefaultPolicies(transaction, input.organizationId, user.id)
  }
  // Automatic team access: the domain match happens HERE, with the address the
  // token just asserted, in memory — only rule ids travel onward. `queue_jobs`
  // rows are never purged, so an email in a payload would be a permanent local
  // copy of UOA identity data. Enqueued inside this transaction (the queue
  // helper needs only `$executeRaw`) so the job cannot exist without the
  // principal; sign-in never waits for it and never fails because of it.
  if (input.uoaSub) {
    await enqueueAutomaticMembershipProvisioning(transaction, {
      email: input.email,
      organizationId: input.organizationId,
      uoaSub: input.uoaSub,
    })
  }
  return {
    id: user.id,
    orgRole: await readOrgRole(transaction, input.organizationId, user.id),
  }
}, AUTH_LOCK_TRANSACTION_OPTIONS)
