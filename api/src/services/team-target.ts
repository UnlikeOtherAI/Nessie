import { Prisma, type MemberRole, type PrismaClient } from '@prisma/client'

import { defaultColumnCreateData } from './board.js'
import {
  resolveExternalTeamSelection,
  type ExternalAuthTeam,
} from './identity-display.js'
import type { UoaTeamDirectoryEntry } from './uoa-team-directory.js'
import {
  NO_UOA_ROLE_CLAIMS,
  resolveUoaRoleClaims,
  type UoaRoleClaims,
} from './uoa-roles.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'

const CREATED_AT_ASC = { createdAt: 'asc' } as const

export class TeamExternalBindingConflictError extends Error {
  constructor() {
    super('The selected external organization and team conflict with an existing team binding.')
    this.name = 'TeamExternalBindingConflictError'
  }
}

// A birth-time placeholder name: the UOA access token carries team ids
// only, so it is healed from UOA's verified team directory by
// `syncExternalTeamNames` (at login and token refresh), mirroring
// org-name healing. `Team.name`/`Project.name` for a UOA-bound team are
// non-authoritative mirrors of UOA's label.
const teamDisplayName = (externalTeamId: string): string =>
  `Team ${externalTeamId.slice(0, 8)}`

/**
 * Mirror UOA's team labels onto the local Team rows and their owning
 * Projects. `Team.name`/`Project.name` for a UOA-bound team are
 * non-authoritative display data (the same doctrine as `Organization.name`),
 * so this runs best-effort beside `syncExternalOrganizationNames` wherever
 * the verified team directory arrives, and only rewrites rows whose
 * stored name differs. An entry with a blank label never blanks a real name.
 */
export const syncExternalTeamNames = async (
  prisma: Pick<PrismaClient, 'team' | 'project'>,
  directory: UoaTeamDirectoryEntry[] | undefined,
): Promise<void> => {
  if (!directory) return
  const labelByExternalTeamId = new Map<string, string>()
  for (const entry of directory) {
    const label = entry.label?.trim()
    if (label) labelByExternalTeamId.set(entry.teamId, label)
  }
  for (const [externalTeamId, label] of labelByExternalTeamId) {
    await prisma.team.updateMany({
      where: { externalTeamId, name: { not: label } },
      data: { name: label },
    })
    await prisma.project.updateMany({
      where: { teams: { some: { externalTeamId } }, name: { not: label } },
      data: { name: label },
    })
  }
}

// The environment a login resolves to: the project/team plus its #general
// channel, the role the joining user should get in that team, and the verified
// UOA claims that are re-projected onto the memberships on every login.
export type TeamTarget = {
  projectId: string
  teamId: string
  channelId: string | null
  teamRole: MemberRole
  claims: UoaRoleClaims
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

// One advisory lock per (external org, team) serializes the target
// existing-or-create branch across replicas and devices.
export const lockExternalTeam = async (
  transaction: Prisma.TransactionClient,
  externalOrgId: string | null,
  externalTeamId: string,
): Promise<void> => {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`nessie:external-team:${externalOrgId ?? 'none'}:${externalTeamId}`},
          0
        )
      )
    ) AS acquired
  `)
}

// Create the project + team + #general channel for a brand-new team inside
// the shared org, bound to the UOA team id. The first person in owns it.
const createTeamEnvironment = async (
  transaction: Prisma.TransactionClient,
  input: { organizationId: string; externalTeamId: string; externalOrgId: string | null },
): Promise<{ projectId: string; teamId: string; channelId: string }> => {
  const name = teamDisplayName(input.externalTeamId)
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
      externalTeamId: input.externalTeamId,
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
export const materializeTeamTargetInTransaction = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  externalTeamId: string,
  team: ExternalAuthTeam | undefined,
): Promise<TeamTarget> => {
  const externalOrgId = resolveExternalTeamSelection(team).organizationId
  const claims = resolveUoaRoleClaims(team, externalTeamId)
  const existing = await tx.team.findUnique({
    where: { externalTeamId: externalTeamId },
    select: {
      externalOrgId: true,
      externalTeamId: true,
      id: true,
      projectId: true,
      project: { select: { organizationId: true } },
    },
  })

  if (existing) {
    if (
      existing.project.organizationId !== organizationId
      || existing.externalTeamId !== externalTeamId
      || existing.externalOrgId !== externalOrgId
    ) {
      throw new TeamExternalBindingConflictError()
    }
    return {
      projectId: existing.projectId,
      teamId: existing.id,
      channelId: await publicChannelId(tx, existing.id),
      teamRole: claims.teamRole ?? 'member',
      claims,
    }
  }

  const created = await createTeamEnvironment(tx, {
    organizationId,
    externalTeamId,
    externalOrgId,
  })
  return {
    projectId: created.projectId,
    teamId: created.teamId,
    channelId: created.channelId,
    // The first person to materialize a team owns its team — but only
    // when UOA sent no role for it. A verified claim is the authority.
    teamRole: claims.teamRole ?? 'owner',
    claims,
  }
}

// Resolve the target team for the selected UOA team: an existing bound team
// (join it), or a freshly provisioned one (the first person owns it).
export const resolveTeamTarget = async (
  prisma: PrismaClient,
  organizationId: string,
  externalTeamId: string,
  team: ExternalAuthTeam | undefined,
): Promise<TeamTarget> => {
  const externalOrgId = resolveExternalTeamSelection(team).organizationId
  return prisma.$transaction(async (tx) => {
    await lockExternalTeam(tx, externalOrgId, externalTeamId)
    return materializeTeamTargetInTransaction(tx, organizationId, externalTeamId, team)
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// The environment when no team was selected (non-UOA OIDC, single-env, or a
// magic-link that skipped the chooser): the user's existing team, else the shared
// org's default team — preserving pre-team auto-provisioning.
export const resolveDefaultTarget = async (
  prisma: Pick<PrismaClient, 'channel' | 'team' | 'teamMember'>,
  organizationId: string,
  userId: string | undefined,
): Promise<TeamTarget | null> => {
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
        claims: NO_UOA_ROLE_CLAIMS,
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
    claims: NO_UOA_ROLE_CLAIMS,
  }
}
