import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

import { defaultColumnCreateData } from './board.js'
import {
  resolveExternalWorkspaceSelection,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import { seedDefaultPolicies } from './policy.js'
import { seedBootstrapRecords } from '../db/seed.js'

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
  displayName: string
  avatarUrl?: string
  workspace?: ExternalAuthWorkspace
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

// Ensure a user has org/project/team/channel membership for a workspace without
// clobbering an existing (possibly higher) role or resurrecting a deactivated
// org membership: create-with-role on first join, leave untouched thereafter.
const ensureWorkspaceMemberships = async (
  prisma: Prisma.TransactionClient,
  input: {
    userId: string
    organizationId: string
    projectId: string
    teamId: string
    channelId: string | null
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
}

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

// Read the user's org role after membership was ensured (owner for the bootstrap
// user, member otherwise) — the role the access token is scoped to.
const readOrgRole = async (
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

// UOA can complete the same principal's callback concurrently on multiple
// devices. Serialize user creation and every membership write across replicas;
// Prisma's upsert alone does not make concurrent create branches conflict-safe.
const ensureWorkspacePrincipal = async (
  prisma: PrismaClient,
  input: {
    avatarUrl?: string
    channelId: string | null
    displayName: string
    email: string
    organizationId: string
    projectId: string
    teamId: string
    teamRole: MemberRole
  },
): Promise<{ id: string; orgRole: MemberRole }> => prisma.$transaction(async (transaction) => {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`nessie:uoa-principal:${input.email}`}, 0)
      )
    ) AS acquired
  `)
  const existing = await transaction.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  })
  const user = existing ?? await transaction.user.create({
    data: {
      avatarUrl: input.avatarUrl,
      displayName: input.displayName,
      email: input.email,
    },
    select: { id: true },
  })
  await ensureWorkspaceMemberships(transaction, {
    userId: user.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    teamId: input.teamId,
    channelId: input.channelId,
    orgRole: 'member',
    teamRole: input.teamRole,
  })
  return {
    id: user.id,
    orgRole: await readOrgRole(transaction, input.organizationId, user.id),
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
        throw new Error(
          'The selected external organization and team conflict with an existing workspace binding.',
        )
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

  // 1. Ensure the shared org exists (bootstrap the first user), and get the user.
  let sharedOrg = await prisma.organization.findFirst({ orderBy: CREATED_AT_ASC })
  let user = await prisma.user.findUnique({ where: { email }, select: { id: true } })

  if (!sharedOrg) {
    if (user || (await prisma.user.count()) > 0) {
      // Users exist but no organization — a corrupt/misconfigured instance.
      return null
    }
    const seeded = await seedBootstrapRecords(prisma, {
      avatarUrl: input.avatarUrl,
      displayName: input.displayName,
      email,
    })
    await seedDefaultPolicies(prisma, seeded.organizationId, seeded.user.id)
    sharedOrg = await prisma.organization.findUnique({ where: { id: seeded.organizationId } })
    user = { id: seeded.user.id }
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
  // advisory lock closes same-email callback races across devices/replicas.
  const principal = await ensureWorkspacePrincipal(prisma, {
    avatarUrl: input.avatarUrl,
    channelId: target.channelId,
    displayName: input.displayName,
    email,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    teamRole: target.teamRole,
  })

  return {
    userId: principal.id,
    organizationId,
    projectId: target.projectId,
    teamId: target.teamId,
    orgRole: principal.orgRole,
  }
}
