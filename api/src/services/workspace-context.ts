import type { MemberRole, Prisma, PrismaClient } from '@prisma/client'

import {
  lockExternalOrganization,
  materializeExternalOrganizationInTransaction,
} from './external-organization.js'
import {
  resolveExternalWorkspaceSelection,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import { seedDefaultPolicies } from './policy.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS, lockUserSessions } from './user-session-lock.js'
import {
  ensureWorkspaceMemberships,
  ensureWorkspacePrincipal,
  findExistingPrincipal,
  isFirstOrganizationMember,
  readOrgRole,
} from './workspace-principal.js'
import {
  lockExternalWorkspace,
  materializeWorkspaceTargetInTransaction,
  resolveDefaultTarget,
  resolveWorkspaceTarget,
  WorkspaceExternalBindingConflictError,
} from './workspace-target.js'
import {
  lockBootstrapInitialization,
  seedBootstrapRecordsInTransaction,
} from '../db/seed.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const

// Kept importable from here: uoa-workspace-switch.ts catches this exact class
// to map binding conflicts to its switch refusal.
export { WorkspaceExternalBindingConflictError }

// The Nessie environment a UOA login resolves to: the per-UOA-org Organization
// (1:1 by `Organization.externalOrgId`), and a project+team representing the
// selected UOA workspace inside it. `orgRole` is the org membership role the
// access token is scoped to (RBAC is org-role driven). Logins with no
// workspace claim (generic OIDC, legacy) keep the shared-org behaviour.
export type WorkspaceContext = {
  userId: string
  organizationId: string
  projectId: string
  teamId: string
  orgRole: MemberRole
}

export type WorkspaceIdentityInput = {
  email: string
  // Only what the provider asserted; absent when it asserted no name. The
  // profile columns are a mirror of those claims, never Nessie's own record.
  displayName?: string
  avatarUrl?: string
  /**
   * Account-bound recovery seam (paired with `existingUserId`): the exact
   * local organization the bearer's SOURCE session holds. With per-UOA-org
   * Organizations the recovery's TARGET org is resolved from the verified
   * workspace claim's org id (a cross-org switch is legitimate and lands in
   * the target org — which may be materialized by this very recovery); this
   * claim is only the fallback scope for a recovery whose workspace claim
   * carries no external org id. Never an ambient "oldest organization"
   * lookup.
   */
  expectedLocalOrganizationId?: string
  /**
   * Account-bound recovery seam: when set, this exact local principal is the
   * login's identity. The resolver never looks up, creates, or remaps a user
   * by email — it locks and reuses this row, and only materializes the target
   * workspace plus its memberships for this id. Used by the workspace-switch
   * reauthorization path, which has already proven the caller is this user.
   */
  existingUserId?: string
  /**
   * Account-bound recovery fence: conditionally claims the TARGET org's
   * Nessie ProductAccountLink row (creating it on first entry into that org,
   * exactly as first login does — see `claimUoaRecoveryAccountLink`).
   * Recovery runs ONE transaction with a stable lock order — the exact
   * external-org and external-workspace advisory locks, then this claim
   * (whose row lock is held to commit), then the target existing-or-create
   * branch and the principal memberships — so a refusal aborts before ANY
   * local write, organization and target materialization included. The
   * callback receives the resolved TARGET organization id, which for a
   * cross-org switch differs from the bearer's source org claim.
   */
  recoveryLinkClaim?: (
    transaction: Prisma.TransactionClient,
    targetOrganizationId: string,
  ) => Promise<void>
  workspace?: ExternalAuthWorkspace
  // Stable UOA subject (`sub`). Present on the UOA provider path only —
  // principal resolution then keys on it (workspace-principal.ts); generic
  // OIDC providers omit it and keep email keying unchanged.
  uoaSub?: string
}

// The single account-bound recovery transaction. Stable lock order:
//   1. exact external-org advisory lock (per-UOA-org serialization), then the
//      exact external-workspace advisory lock (target serialization),
//   2. user-session lock + the TARGET organization resolve-or-create +
//      conditional account-link claim (the fence; its row lock is held to
//      commit),
//   3. target existing-or-create + the exact principal's memberships.
// The target org comes from the verified workspace claim's external org id —
// a cross-org switch recovery legitimately lands (and may first materialize)
// the target Organization; the bearer's `expectedLocalOrganizationId` is only
// the fallback scope when the claim carries no external org id. A fence
// refusal at step 2 rolls back before ANY local write — organization
// materialization included; every write below commits only while the claimed
// link row lock is still held, so no concurrent epoch advance can interleave
// after the claim. Identity is the bearer-proven user id — recovery never
// resolves, adopts, or creates a principal by email or subject claim.
const resolveRecoveryContext = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    recoveryLinkClaim?: (
      transaction: Prisma.TransactionClient,
      targetOrganizationId: string,
    ) => Promise<void>
    userId: string
    workspace?: ExternalAuthWorkspace
    workspaceId?: string
  },
): Promise<WorkspaceContext | null> => prisma.$transaction(async (tx) => {
  const externalOrgId = input.workspaceId
    ? resolveExternalWorkspaceSelection(input.workspace).organizationId
    : null
  if (input.workspaceId) {
    if (externalOrgId) {
      await lockExternalOrganization(tx, externalOrgId)
    }
    await lockExternalWorkspace(tx, externalOrgId, input.workspaceId)
  }
  await lockUserSessions(tx, input.userId)
  const existing = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!existing) {
    return null
  }
  // The TARGET org: the per-UOA-org Organization for the claim's external org
  // id (materialized here on a first entry, under its advisory lock and
  // before the fence claim so a refusal rolls it back), else the bearer's
  // source-org claim for a legacy selection with no external org id.
  const organizationId = externalOrgId
    ? (await materializeExternalOrganizationInTransaction(tx, externalOrgId)).id
    : input.organizationId
  if (input.recoveryLinkClaim) {
    await input.recoveryLinkClaim(tx, organizationId)
  }
  const target = input.workspaceId
    ? await materializeWorkspaceTargetInTransaction(
        tx,
        organizationId,
        input.workspaceId,
        input.workspace,
      )
    : await resolveDefaultTarget(tx, organizationId, existing.id)
  if (!target) {
    return null
  }
  const firstOrgMember = externalOrgId
    ? await isFirstOrganizationMember(tx, organizationId)
    : false
  // Recovery is a login-equivalent for the target workspace: the memberships
  // helper re-projects the verified UOA role claims exactly as the login path
  // does, so a switch-recovery cannot resurrect a role UOA no longer asserts.
  await ensureWorkspaceMemberships(tx, {
    userId: existing.id,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    channelId: target.channelId,
    claims: target.claims,
    orgRole: target.claims.orgRole ?? (firstOrgMember ? 'owner' : 'member'),
    teamRole: target.teamRole,
  })
  if (firstOrgMember) {
    await seedDefaultPolicies(tx, organizationId, existing.id)
  }
  return {
    userId: existing.id,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    orgRole: await readOrgRole(tx, organizationId, existing.id),
  }
}, AUTH_LOCK_TRANSACTION_OPTIONS)

const initializeSharedOrganization = async (
  prisma: PrismaClient,
  input: WorkspaceIdentityInput & { email: string; existingUserId?: undefined },
): Promise<{
  sharedOrg: { id: string }
  user: { id: string } | null
} | null> => prisma.$transaction(async (transaction) => {
  await lockBootstrapInitialization(transaction)
  const [sharedOrg, user] = await Promise.all([
    transaction.organization.findFirst({
      orderBy: CREATED_AT_ASC,
      select: { id: true },
    }),
    findExistingPrincipal(transaction, { email: input.email, uoaSub: input.uoaSub }),
  ])
  if (sharedOrg) {
    return { sharedOrg, user }
  }
  if (user || (await transaction.user.count()) > 0) {
    return null
  }
  const seeded = await seedBootstrapRecordsInTransaction(transaction, {
    avatarUrl: input.avatarUrl,
    // The seed row needs a name; the address is the honest placeholder when the
    // provider asserted none. `ensureWorkspacePrincipal` re-syncs the mirror
    // from the claims immediately afterwards.
    displayName: input.displayName ?? input.email,
    email: input.email,
  })
  return {
    sharedOrg: { id: seeded.organizationId },
    user: { id: seeded.user.id },
  }
}, AUTH_LOCK_TRANSACTION_OPTIONS)

/**
 * Resolve the Nessie environment a UOA login lands in (UOA organisation →
 * Organization, workspace → team). Returns the org/project/team the session is
 * scoped to.
 *
 * - `existingUserId` set (account-bound recovery) → ONE transaction:
 *   external-org + external-workspace locks, target-organization
 *   resolve-or-create, conditional account-link claim, target
 *   existing-or-create, and exact-principal memberships. Recovery never
 *   resolves, creates, or remaps a user by email.
 * - Workspace selection with an external org id → the per-UOA-org Organization
 *   (resolved-or-created 1:1 by `Organization.externalOrgId` under its
 *   advisory lock — never the ambient oldest-organization lookup), with the
 *   workspace project+team materialized INSIDE it. First entry into a
 *   brand-new org: the `org_role` claim decides the local role; with no claim
 *   the first materializer of the org owns it (mirror of the team rule).
 * - No workspace selection → the shared/default org and the user's
 *   existing/default team (generic OIDC and legacy logins, byte-for-byte).
 * - Known workspace, team exists → join it.
 * - Known workspace, no team yet → auto-provision it; the first person owns it
 *   unless UOA sent a role for that workspace, which wins.
 *
 * Roles are a projection of the verified UOA claims, re-applied on every login
 * and recovery (`uoa-roles.ts`), so a UOA promotion or demotion propagates.
 * Dimensions UOA did not claim are left exactly as they were.
 */
export const resolveUoaWorkspaceContext = async (
  prisma: PrismaClient,
  input: WorkspaceIdentityInput,
): Promise<WorkspaceContext | null> => {
  // Recovery: the target org comes from the verified workspace claim (falling
  // back to the bearer's exact local organization claim), never from an
  // ambient organization lookup — no shared-org probe, no bootstrap; the
  // single recovery transaction materializes org and target under the claimed
  // account-link row lock.
  if (input.existingUserId) {
    if (!input.expectedLocalOrganizationId) {
      return null
    }
    return resolveRecoveryContext(prisma, {
      organizationId: input.expectedLocalOrganizationId,
      recoveryLinkClaim: input.recoveryLinkClaim,
      userId: input.existingUserId,
      workspace: input.workspace,
      workspaceId:
        resolveExternalWorkspaceSelection(input.workspace).teamId ?? undefined,
    })
  }

  const email = input.email.trim().toLowerCase()
  const selection = resolveExternalWorkspaceSelection(input.workspace)
  const workspaceId = selection.teamId ?? undefined

  // A workspace selection carrying an external org id is structurally a UOA
  // login: the UOA organisation maps 1:1 to a local Organization. Everything
  // else (generic OIDC, legacy no-workspace logins) keeps the shared-org path
  // below byte-for-byte.
  if (workspaceId && selection.organizationId) {
    const externalOrgId = selection.organizationId
    const resolved = await prisma.$transaction(async (tx) => {
      // Lock order: external-org, then external-workspace — the same order
      // the recovery transaction and the principal transaction use.
      await lockExternalOrganization(tx, externalOrgId)
      const organization =
        await materializeExternalOrganizationInTransaction(tx, externalOrgId)
      await lockExternalWorkspace(tx, externalOrgId, workspaceId)
      const target = await materializeWorkspaceTargetInTransaction(
        tx,
        organization.id,
        workspaceId,
        input.workspace,
      )
      return { organizationId: organization.id, target }
    }, AUTH_LOCK_TRANSACTION_OPTIONS)

    const principal = await ensureWorkspacePrincipal(prisma, {
      avatarUrl: input.avatarUrl,
      channelId: resolved.target.channelId,
      claims: resolved.target.claims,
      displayName: input.displayName,
      email,
      externalOrgId,
      organizationId: resolved.organizationId,
      projectId: resolved.target.projectId,
      teamId: resolved.target.teamId,
      teamRole: resolved.target.teamRole,
      uoaSub: input.uoaSub,
    })

    return {
      userId: principal.id,
      organizationId: resolved.organizationId,
      projectId: resolved.target.projectId,
      teamId: resolved.target.teamId,
      orgRole: principal.orgRole,
    }
  }

  // 1. Ensure the shared org exists (bootstrap the first user), and get the
  // user — by stable UOA subject first, by email only as the adoption bridge.
  let sharedOrg = await prisma.organization.findFirst({
    orderBy: CREATED_AT_ASC,
    select: { id: true },
  })
  let user = await findExistingPrincipal(prisma, { email, uoaSub: input.uoaSub })

  if (!sharedOrg) {
    const initialized = await initializeSharedOrganization(prisma, {
      avatarUrl: input.avatarUrl,
      displayName: input.displayName,
      email,
      uoaSub: input.uoaSub,
      workspace: input.workspace,
    })
    if (!initialized) {
      // Users exist but no organization — a corrupt/misconfigured instance.
      return null
    }
    sharedOrg = initialized.sharedOrg
    user = initialized.user
  }

  if (!sharedOrg) {
    return null
  }
  const organizationId = sharedOrg.id

  // 2. Resolve the target environment (workspace team, or default team).
  const target = workspaceId
    ? await resolveWorkspaceTarget(prisma, organizationId, workspaceId, input.workspace)
    : await resolveDefaultTarget(prisma, organizationId, user?.id)
  if (!target) {
    return null
  }

  // 3. Resolve one stable local principal after validating the target. The
  // advisory locks (subject + email) close same-principal callback races
  // across devices/replicas; a UOA email row bound to a different subject
  // fails closed here with UoaSubjectConflictError before any write.
  const principal = await ensureWorkspacePrincipal(prisma, {
    avatarUrl: input.avatarUrl,
    channelId: target.channelId,
    claims: target.claims,
    displayName: input.displayName,
    email,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    teamRole: target.teamRole,
    uoaSub: input.uoaSub,
  })

  return {
    userId: principal.id,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    orgRole: principal.orgRole,
  }
}
