import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

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
 * under the advisory locks in `ensureWorkspacePrincipal`.
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

// Ensure a user has org/project/team/channel membership for a workspace. The
// upserts are create-only — they never resurrect a deactivated org membership
// or rewrite a role behind UOA's back. Role *changes* come from exactly one
// place afterwards: `projectUoaRoles`, replaying the verified claims, so a
// dimension UOA did not claim keeps whatever the row already held.
// Exported for the account-bound recovery transaction in workspace-context.ts,
// which writes memberships for an already-proven principal inside its own
// locked transaction.
export const ensureWorkspaceMemberships = async (
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

// Read the user's org role after membership was ensured and UOA's claims were
// projected — the role the access token is scoped to. Exported for the
// account-bound recovery transaction in workspace-context.ts.
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
export const ensureWorkspacePrincipal = async (
  prisma: PrismaClient,
  input: PrincipalIdentityInput & {
    channelId: string | null
    claims: UoaRoleClaims
    organizationId: string
    projectId: string
    teamId: string
    teamRole: MemberRole
  },
): Promise<{ id: string; orgRole: MemberRole }> => prisma.$transaction(async (transaction) => {
  // UOA logins serialize on the stable subject — the principal key. The email
  // lock is STILL taken (second, always in this order, so the pair cannot
  // deadlock): the adoption path resolves and claims rows through the unique
  // `email` column, and non-UOA logins keep email keying entirely, so two
  // different subjects racing one email address — or a UOA login racing a
  // generic OIDC login for the same address — must meet on a common lock
  // rather than on the read-then-create window.
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
  await ensureWorkspaceMemberships(transaction, {
    userId: user.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    teamId: input.teamId,
    channelId: input.channelId,
    claims: input.claims,
    // UOA's verified `org_role` decides the org membership; `member` is only
    // the default for a login that carried no such claim.
    orgRole: input.claims.orgRole ?? 'member',
    teamRole: input.teamRole,
  })
  return {
    id: user.id,
    orgRole: await readOrgRole(transaction, input.organizationId, user.id),
  }
}, AUTH_LOCK_TRANSACTION_OPTIONS)
