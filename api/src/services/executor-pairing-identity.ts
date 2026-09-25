import type { Executor, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import {
  createUoaSubjectAssertion, loadUoaDelegatedIdentitySettings, requestUoaOrganization,
  type UoaOrgRequestDeps, type UoaDelegatedIdentitySettings,
} from '@nessie/runtime'
import { ExecutorError, EXECUTOR_ERROR_CODES, type PairingClaimAuthority } from '@nessie/executor-manage'
import type { AuthorizedActionContext, ExecutorPairingOptions, UoaSessionIdentity } from '@nessie/schemas'
import { parseUoaTeamDirectoryPayload } from './uoa-team-directory.js'

function refuse(): never {
  throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'Your organisation or team access is unavailable.')
}
const LiveOrgSchema = z.object({ org: z.object({
  org_id: z.string(), org_role: z.string(), teams: z.array(z.string()),
}) })

/** UOA names are response-only; no directory or profile mirror is written. */
export const executorPairingAuthority = async (
  prisma: PrismaClient, input: { organizationId: string; userId: string; identity?: UoaSessionIdentity },
  deps: UoaOrgRequestDeps & { settings?: UoaDelegatedIdentitySettings | null } = {},
): Promise<PairingClaimAuthority> => {
  const organization = await prisma.organization.findUnique({ where: { id: input.organizationId } })
  if (!organization) refuse()
  let organizationName: string
  let manager: boolean
  let teams: ExecutorPairingOptions['teams']
  if (organization.externalOrgId) {
    const identity = input.identity
    const settings = deps.settings === undefined ? loadUoaDelegatedIdentitySettings() : deps.settings
    if (!identity || identity.tokenVersion === null
      || identity.organizationId !== organization.externalOrgId || !settings) refuse()
    const link = await prisma.productAccountLink.findUnique({ where: { organizationId_userId_productSlug: {
      organizationId: organization.id, userId: input.userId, productSlug: 'nessie',
    } } })
    if (link?.status !== 'linked' || link.uoaSub !== identity.subject || link.uoaTokenVersion !== identity.tokenVersion) refuse()
    const payload = await requestUoaOrganization(settings, '/org/me', { method: 'GET' }, {
      ...deps,
      subjectAssertion: createUoaSubjectAssertion(settings, {
        organizationId: identity.organizationId, subject: identity.subject,
        teamId: identity.teamId, tokenVersion: identity.tokenVersion,
      }, `${settings.authBaseUrl}/org`),
    })
    const parsed = LiveOrgSchema.safeParse(payload)
    if (!parsed.success || parsed.data.org.org_id !== organization.externalOrgId) refuse()
    const org = parsed.data.org
    manager = org.org_role === 'owner' || org.org_role === 'admin'
    const entries = parseUoaTeamDirectoryPayload(payload, settings.authBaseUrl)?.entries.filter((entry) =>
      entry.organizationId === organization.externalOrgId && org.teams.includes(entry.teamId)) ?? []
    organizationName = entries.find((entry) => entry.orgName)?.orgName ?? ''
    if (!organizationName) refuse()
    const references = await prisma.team.findMany({ where: {
      externalOrgId: organization.externalOrgId, externalTeamId: { in: entries.map((entry) => entry.teamId) },
      project: { organizationId: organization.id },
    }, select: { id: true, externalTeamId: true } })
    const projects = await prisma.project.findMany({ where: {
      organizationId: organization.id, teamId: { in: references.map((team) => team.id) },
    }, select: { id: true, teamId: true } })
    teams = entries.map((entry) => ({ id: entry.teamId, name: entry.label,
      projectIds: projects.filter((project) => references.some((team) =>
        team.id === project.teamId && team.externalTeamId === entry.teamId)).map((project) => project.id),
    }))
  } else {
    const member = await prisma.organizationMember.findUnique({ where: { organizationId_userId: {
      organizationId: organization.id, userId: input.userId,
    } } })
    if (!member || member.deactivatedAt) refuse()
    organizationName = organization.name
    manager = member.role === 'owner' || member.role === 'admin'
    const localTeams = await prisma.team.findMany({ where: {
      project: { organizationId: organization.id }, systemManaged: false,
      ...(manager ? {} : { members: { some: { userId: input.userId } } }),
    }, select: { id: true, name: true } })
    const projects = await prisma.project.findMany({ where: {
      organizationId: organization.id, teamId: { in: localTeams.map((team) => team.id) },
    }, select: { id: true, teamId: true } })
    teams = localTeams.map((team) => ({
      ...team, projectIds: projects.filter((p) => p.teamId === team.id).map((p) => p.id),
    }))
  }
  const manageableProjects = await prisma.project.findMany({ where: {
    organizationId: organization.id,
    ...(manager ? {} : { members: { some: { userId: input.userId, role: { in: ['owner', 'admin'] } } } }),
  }, select: { id: true } })
  const projectIds = manageableProjects.map((project) => project.id)
  return { userId: input.userId, projectIds, options: {
    organization: { id: organization.id, name: organizationName },
    teams: teams.map((team) => ({ ...team, projectIds: team.projectIds.filter((id) => projectIds.includes(id)) })),
    scopes: ['private', ...(projectIds.length ? ['project' as const] : []), ...(manager ? ['organization' as const] : [])],
  } }
}

export const pairingAuthorityForActor = async (prisma: PrismaClient, actor: AuthorizedActionContext) => {
  if (actor.actor.actorType !== 'user' || actor.actionContext.agentCredentialId) refuse()
  const authority = await executorPairingAuthority(prisma, {
    organizationId: actor.tenant.organizationId, userId: actor.actor.actorId, identity: actor.actionContext.uoaIdentity,
  })
  const team = actor.tenant.teamId ? await prisma.team.findFirst({
    where: { id: actor.tenant.teamId, project: { organizationId: actor.tenant.organizationId } },
    select: { id: true, externalTeamId: true },
  }) : null
  return { ...authority, options: { ...authority.options, scopes: ['private' as const],
    teams: authority.options.teams.filter((entry) =>
      team && (entry.id === team.id || entry.id === team.externalTeamId)),
  } }
}

/** An authenticated machine may resolve names through its pairing owner's live
 * subject reference, but never reads a retained name or membership projection. */
export const executorPairingNames = async (prisma: PrismaClient, executor: Executor) => {
  const link = await prisma.productAccountLink.findUnique({ where: { organizationId_userId_productSlug: {
    organizationId: executor.organizationId, userId: executor.pairingOwnerUserId, productSlug: 'nessie',
  } } })
  const identity = link?.status === 'linked' && link.activeOrgId && link.activeTeamId && link.uoaSub
    ? {
        organizationId: link.activeOrgId, teamId: link.activeTeamId,
        subject: link.uoaSub, tokenVersion: link.uoaTokenVersion,
      }
    : undefined
  const authority = await executorPairingAuthority(prisma, {
    organizationId: executor.organizationId, userId: executor.pairingOwnerUserId, identity,
  })
  const team = executor.pairingTeamId
    ? authority.options.teams.find((entry) => entry.id === executor.pairingTeamId) : null
  if (executor.pairingTeamId && !team) refuse()
  if (!authority.options.scopes.includes(executor.scopeKind)
    || (executor.scopeKind === 'project' && !authority.projectIds.includes(executor.projectId ?? ''))) refuse()
  return { organization: authority.options.organization, team: team ? { id: team.id, name: team.name } : null }
}
