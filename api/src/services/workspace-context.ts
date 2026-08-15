import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

import { defaultColumnCreateData } from './board.js'
import {
  resolveExternalWorkspaceSelection,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import {
  ensureWorkspacePrincipal,
  findExistingPrincipal,
} from './workspace-principal.js'
import {
  lockBootstrapInitialization,
  seedBootstrapRecordsInTransaction,
} from '../db/seed.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const

// The Nessie environment a UOA login resolves to: one shared organization, and a
// project+team representing the selected UOA workspace. `orgRole` is the org
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
  // Only what the provider asserted; absent when it asserted no name. The
  // profile columns are a mirror of those claims, never Nessie's own record.
  displayName?: string
  avatarUrl?: string
  workspace?: ExternalAuthWorkspace
  // Stable UOA subject (`sub`). Present on the UOA provider path only —
  // principal resolution then keys on it (workspace-principal.ts); generic
  // OIDC providers omit it and keep email keying unchanged.
  uoaSub?: string
}

export class WorkspaceExternalBindingConflictError extends Error {
  constructor() {
    super('The selected external organization and team conflict with an existing workspace binding.')
    this.name = 'WorkspaceExternalBindingConflictError'
  }
}

// UOA team roles (`owner | admin | member`, plus legacy `lead`) → Nessie MemberRole.
const mapUoaTeamRole = (role: string | undefined): MemberRole => {
  switch ((role ?? '').trim().toLowerCase()) {
    case 'owner':
      return 'owner'
    case 'admin':
    case 'lead':
      return 'admin'
    default:
      return 'member'
  }
}

// A friendly-enough placeholder name; the UOA access token carries workspace ids
// only, so owners rename via team settings (see the plan doc's follow-ups).
const workspaceDisplayName = (workspaceId: string): string =>
  `Workspace ${workspaceId.slice(0, 8)}`

// Create the project + team + #general channel for a brand-new workspace inside
// the shared org, bound to the UOA workspace id. The first person in owns it.
const createWorkspaceEnvironment = async (
  transaction: Prisma.TransactionClient,
  input: { organizationId: string; workspaceId: string; externalOrgId: string | null },
): Promise<{ projectId: string; teamId: string; channelId: string }> => {
  const name = workspaceDisplayName(input.workspaceId)
  const project = await transaction.project.create({
    data: { name, organizationId: input.organizationId },
  })
  await transaction.boardColumn.createMany({
    data: defaultColumnCreateData(input.organizationId).map((column) => ({
      ...column,
      projectId: project.id,
    })),
  })
  const team = await transaction.team.create({
    data: {
      name,
      projectId: project.id,
      externalWorkspaceId: input.workspaceId,
      externalOrgId: input.externalOrgId,
    },
  })
  const channel = await transaction.channel.create({
    data: {
      label: 'General',
      slug: 'general',
      organizationId: input.organizationId,
      projectId: project.id,
      teamId: team.id,
      visibility: 'public',
    },
  })
  return { projectId: project.id, teamId: team.id, channelId: channel.id }
}

// The environment a login resolves to: the project/team plus its #general
// channel and the role the joining user should get in that team.
type WorkspaceTarget = {
  projectId: string
  teamId: string
  channelId: string | null
  teamRole: MemberRole
}

const publicChannelId = async (
  prisma: Pick<PrismaClient, 'channel'>,
  teamId: string,
): Promise<string | null> => {
  const channel = await prisma.channel.findFirst({
    where: { teamId, visibility: 'public' },
    orderBy: CREATED_AT_ASC,
    select: { id: true },
  })
  return channel?.id ?? null
}

const initializeSharedOrganization = async (
  prisma: PrismaClient,
  input: WorkspaceIdentityInput & { email: string },
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
    findExistingPrincipal(transaction, input),
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

// Resolve the target team for the selected UOA workspace: an existing bound team
// (join it), or a freshly provisioned one (the first person owns it).
const resolveWorkspaceTarget = async (
  prisma: PrismaClient,
  organizationId: string,
  workspaceId: string,
  workspace: ExternalAuthWorkspace | undefined,
): Promise<WorkspaceTarget> => {
  const externalOrgId = resolveExternalWorkspaceSelection(workspace).organizationId
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT 1
      FROM (
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`nessie:external-workspace:${externalOrgId ?? 'none'}:${workspaceId}`},
            0
          )
        )
      ) AS acquired
    `)
    const existing = await tx.team.findUnique({
      where: { externalWorkspaceId: workspaceId },
      select: {
        externalOrgId: true,
        externalWorkspaceId: true,
        id: true,
        projectId: true,
        project: { select: { organizationId: true } },
      },
    })

    if (existing) {
      if (
        existing.project.organizationId !== organizationId
        || existing.externalWorkspaceId !== workspaceId
        || existing.externalOrgId !== externalOrgId
      ) {
        throw new WorkspaceExternalBindingConflictError()
      }
      return {
        projectId: existing.projectId,
        teamId: existing.id,
        channelId: await publicChannelId(tx, existing.id),
        teamRole: mapUoaTeamRole(workspace?.teamRoles?.[workspaceId]),
      }
    }

    const created = await createWorkspaceEnvironment(tx, {
      organizationId,
      workspaceId,
      externalOrgId,
    })
    return {
      projectId: created.projectId,
      teamId: created.teamId,
      channelId: created.channelId,
      teamRole: 'owner',
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// The environment when no workspace was selected (non-UOA OIDC, single-env, or a
// magic-link that skipped the chooser): the user's existing team, else the shared
// org's default team — preserving pre-workspace auto-provisioning.
const resolveDefaultTarget = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string | undefined,
): Promise<WorkspaceTarget | null> => {
  if (userId) {
    const membership = await prisma.teamMember.findFirst({
      where: { userId, team: { project: { organizationId } } },
      orderBy: CREATED_AT_ASC,
      select: { teamId: true, team: { select: { projectId: true } } },
    })
    if (membership) {
      return {
        projectId: membership.team.projectId,
        teamId: membership.teamId,
        channelId: await publicChannelId(prisma, membership.teamId),
        teamRole: 'member',
      }
    }
  }

  const defaultTeam = await prisma.team.findFirst({
    where: { project: { organizationId } },
    orderBy: CREATED_AT_ASC,
    select: { id: true, projectId: true },
  })
  if (!defaultTeam) {
    return null
  }
  return {
    projectId: defaultTeam.projectId,
    teamId: defaultTeam.id,
    channelId: await publicChannelId(prisma, defaultTeam.id),
    teamRole: 'member',
  }
}

/**
 * Resolve the Nessie environment a UOA login lands in (Slack-style workspace →
 * team). Ensures the shared org + user exist, then resolves-or-creates the
 * project/team/#general for the selected UOA workspace and the user's
 * memberships. Returns the org/project/team the session is scoped to.
 *
 * - No workspace selection → the user's existing/default team (legacy behaviour).
 * - Known workspace, team exists → join it (create-only role, never downgraded).
 * - Known workspace, no team yet → auto-provision it; the first person owns it.
 */
export const resolveUoaWorkspaceContext = async (
  prisma: PrismaClient,
  input: WorkspaceIdentityInput,
): Promise<WorkspaceContext | null> => {
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
      ...input,
      email,
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
