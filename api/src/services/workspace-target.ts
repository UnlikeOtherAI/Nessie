import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

import { defaultColumnCreateData } from './board.js'
import {
  resolveExternalWorkspaceSelection,
  type ExternalAuthWorkspace,
} from './identity-display.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const

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

// The environment a login resolves to: the project/team plus its #general
// channel and the role the joining user should get in that team.
export type WorkspaceTarget = {
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

// One advisory lock per (external org, workspace) serializes the target
// existing-or-create branch across replicas and devices.
export const lockExternalWorkspace = async (
  transaction: Prisma.TransactionClient,
  externalOrgId: string | null,
  workspaceId: string,
): Promise<void> => {
  await transaction.$queryRaw(Prisma.sql`
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

// The target branch itself: join the existing bound team (validating the
// binding against this organization and selection), or provision a fresh
// project/team/#general owned by the first person in.
export const materializeWorkspaceTargetInTransaction = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  workspaceId: string,
  workspace: ExternalAuthWorkspace | undefined,
): Promise<WorkspaceTarget> => {
  const externalOrgId = resolveExternalWorkspaceSelection(workspace).organizationId
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
}

// Resolve the target team for the selected UOA workspace: an existing bound team
// (join it), or a freshly provisioned one (the first person owns it).
export const resolveWorkspaceTarget = async (
  prisma: PrismaClient,
  organizationId: string,
  workspaceId: string,
  workspace: ExternalAuthWorkspace | undefined,
): Promise<WorkspaceTarget> => {
  const externalOrgId = resolveExternalWorkspaceSelection(workspace).organizationId
  return prisma.$transaction(async (tx) => {
    await lockExternalWorkspace(tx, externalOrgId, workspaceId)
    return materializeWorkspaceTargetInTransaction(tx, organizationId, workspaceId, workspace)
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// The environment when no workspace was selected (non-UOA OIDC, single-env, or a
// magic-link that skipped the chooser): the user's existing team, else the shared
// org's default team — preserving pre-workspace auto-provisioning.
export const resolveDefaultTarget = async (
  prisma: Pick<PrismaClient, 'channel' | 'team' | 'teamMember'>,
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
