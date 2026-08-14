import type { MemberRole, Prisma, PrismaClient } from '@prisma/client'

import {
  resolveExternalWorkspaceSelection,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS, lockUserSessions } from './user-session-lock.js'
import {
  ensureWorkspaceMemberships,
  ensureWorkspacePrincipal,
  findExistingPrincipal,
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

// The Nessie environment a UOA login resolves to: one shared organization, and
// a project+team representing the selected UOA workspace. `orgRole` is the org
// membership role the access token is scoped to (RBAC is org-role driven).
export type WorkspaceContext = {
  userId: string
  organizationId: string
  projectId: string
  teamId: string
  orgRole: MemberRole
}

export type WorkspaceIdentityInput = {
  email: string
  displayName: string
  avatarUrl?: string
  /**
   * Account-bound recovery seam (paired with `existingUserId`): the exact
   * local organization the bearer's session holds. Recovery is scoped by
   * this claim, never by an ambient "oldest organization" lookup — if the
   * org this resolver would use differs, the recovery rejects before any
   * target or team provisioning.
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
   * Account-bound recovery fence: conditionally claims the exact Nessie
   * ProductAccountLink row the pre-billing check read. Recovery runs ONE
   * transaction with a stable lock order — the exact external-workspace
   * advisory lock, then this claim (whose row lock is held to commit), then
   * the target existing-or-create branch and the principal memberships — so
   * a refusal aborts before ANY local write, target materialization
   * included.
   */
  recoveryLinkClaim?: (
    transaction: Prisma.TransactionClient,
  ) => Promise<void>
  workspace?: ExternalAuthWorkspace
  // Stable UOA subject (`sub`). Present on the UOA provider path only —
  // principal resolution then keys on it (workspace-principal.ts); generic
  // OIDC providers omit it and keep email keying unchanged.
  uoaSub?: string
}

// The single account-bound recovery transaction. Stable lock order:
//   1. exact external-workspace advisory lock (target serialization),
//   2. user-session lock + conditional account-link claim (the fence; its
//      row lock is held to commit),
//   3. target existing-or-create + the exact principal's memberships.
// A fence refusal at step 2 rolls back before ANY local write; every write
// below commits only while the claimed link row lock is still held, so no
// concurrent epoch advance can interleave after the claim. Identity is the
// bearer-proven user id — recovery never resolves, adopts, or creates a
// principal by email or subject claim.
const resolveRecoveryContext = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    recoveryLinkClaim?: (
      transaction: Prisma.TransactionClient,
    ) => Promise<void>
    userId: string
    workspace?: ExternalAuthWorkspace
    workspaceId?: string
  },
): Promise<WorkspaceContext | null> => prisma.$transaction(async (tx) => {
  if (input.workspaceId) {
    await lockExternalWorkspace(
      tx,
      resolveExternalWorkspaceSelection(input.workspace).organizationId,
      input.workspaceId,
    )
  }
  await lockUserSessions(tx, input.userId)
  const existing = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!existing) {
    return null
  }
  if (input.recoveryLinkClaim) {
    await input.recoveryLinkClaim(tx)
  }
  const target = input.workspaceId
    ? await materializeWorkspaceTargetInTransaction(
        tx,
        input.organizationId,
        input.workspaceId,
        input.workspace,
      )
    : await resolveDefaultTarget(tx, input.organizationId, existing.id)
  if (!target) {
    return null
  }
  await ensureWorkspaceMemberships(tx, {
    userId: existing.id,
    organizationId: input.organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    channelId: target.channelId,
    orgRole: 'member',
    teamRole: target.teamRole,
  })
  return {
    userId: existing.id,
    organizationId: input.organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    orgRole: await readOrgRole(tx, input.organizationId, existing.id),
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
    displayName: input.displayName,
    email: input.email,
  })
  return {
    sharedOrg: { id: seeded.organizationId },
    user: { id: seeded.user.id },
  }
}, AUTH_LOCK_TRANSACTION_OPTIONS)

/**
 * Resolve the Nessie environment a UOA login lands in (Slack-style workspace →
 * team). Returns the org/project/team the session is scoped to.
 *
 * - `existingUserId` set (account-bound recovery) → ONE transaction:
 *   external-workspace lock, conditional account-link claim, target
 *   existing-or-create, and exact-principal memberships. The local org comes
 *   only from the bearer's claim; recovery never bootstraps an org and never
 *   resolves, creates, or remaps a user by email.
 * - No workspace selection → the user's existing/default team (legacy behaviour).
 * - Known workspace, team exists → join it (create-only role, never downgraded).
 * - Known workspace, no team yet → auto-provision it; the first person owns it.
 */
export const resolveUoaWorkspaceContext = async (
  prisma: PrismaClient,
  input: WorkspaceIdentityInput,
): Promise<WorkspaceContext | null> => {
  // Recovery is scoped by the bearer's exact local organization claim, never
  // by an ambient organization lookup: no shared-org probe, no bootstrap —
  // the org exists for any account holding a renewable session, and the
  // single recovery transaction below materializes the target under the
  // claimed account-link row lock.
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
  const workspaceId =
    resolveExternalWorkspaceSelection(input.workspace).teamId ?? undefined
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
