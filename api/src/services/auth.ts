import type { PrismaClient, User } from '@prisma/client'
import type { AuthProviderConfig, NessieConfig } from '@nessie/config'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type AuthorizedActionContext,
  type AuthProviderResponseType,
  type MeMembership,
  type MeResponse,
} from '@nessie/schemas'
import type { SessionTokenClaims } from '../auth/session.js'
import type { AuthProviderDescriptor } from '../contracts.js'
import { buildGravatarUrl } from '../lib/gravatar.js'
import { resolveStoredDisplayName } from './identity-display.js'

export const LOCAL_AUTH_PROVIDER_ID = 'local'

const LOCAL_AUTH_PROVIDER_LABEL = 'Email and password'

const UOA_DEFAULT_BASE_URL = 'https://authentication.unlikeotherai.com'

// The public-facing URL of the authenticator behind a provider, shown in the
// profile. OIDC/custom carry it in config; UOA's lives in the UOA_BASE_URL env
// (with the same default the worker uses), not the per-provider config block.
const resolveProviderUrl = (provider: AuthProviderConfig): string | undefined => {
  if (provider.issuerUrl) {
    return provider.issuerUrl
  }
  if (provider.type === 'uoa') {
    return (process.env.UOA_BASE_URL ?? UOA_DEFAULT_BASE_URL).replace(/\/$/, '')
  }
  return undefined
}

const createLocalProvider = (): AuthProviderDescriptor => ({
  providerId: LOCAL_AUTH_PROVIDER_ID,
  type: 'local-bootstrap',
  label: LOCAL_AUTH_PROVIDER_LABEL,
  enabled: true,
  autoRedirect: false,
})

export const listAuthProviders = (config: NessieConfig): AuthProviderDescriptor[] => {
  const configuredProviders = config.auth.providers.map((provider) => ({
    providerId: provider.providerId,
    type: provider.type as AuthProviderResponseType,
    label: provider.label,
    enabled: provider.enabled,
    autoRedirect: provider.autoRedirect,
    url: resolveProviderUrl(provider),
  }))

  return config.mode === 'local' ? [createLocalProvider(), ...configuredProviders] : configuredProviders
}

export const resolveConfiguredAuthProvider = (
  config: NessieConfig,
  providerId: string,
): AuthProviderConfig | null =>
  config.auth.providers.find(
    (provider) => provider.providerId === providerId && provider.enabled,
  ) ?? null

export const createActorContextFromClaims = (
  claims: SessionTokenClaims,
): AuthorizedActionContext => ({
  actor: {
    actorType: 'user',
    actorId: parseUserId(claims.sub),
    roles: claims.roles,
  },
  tenant: {
    organizationId: parseOrganizationId(claims.org),
    projectId: parseProjectId(claims.proj),
    teamId: parseTeamId(claims.team),
  },
  actionContext: {
    requestId: crypto.randomUUID(),
    sessionId: claims.sid,
    ...(claims.uoaIdentity ? { uoaIdentity: claims.uoaIdentity } : {}),
  },
})

export const loadUserMemberships = async (
  prisma: PrismaClient,
  userId: string,
): Promise<MeMembership[]> => {
  // Three flat queries grouped in memory rather than a nested loop: this runs on
  // every /auth/me, and the previous shape issued one project query per
  // organisation plus one team query per project.
  const [orgMembers, projectMembers, teamMembers] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { userId },
      include: { organization: { select: { id: true, name: true } } },
    }),
    prisma.projectMember.findMany({
      where: { userId },
      include: { project: { select: { id: true, name: true, organizationId: true } } },
    }),
    prisma.teamMember.findMany({
      where: { userId },
      include: { team: { select: { id: true, name: true, projectId: true } } },
    }),
  ])

  type MeTeam = MeMembership['projects'][number]['teams'][number]
  const teamsByProject = new Map<string, MeTeam[]>()
  for (const tm of teamMembers) {
    const list = teamsByProject.get(tm.team.projectId) ?? []
    list.push({ teamId: parseTeamId(tm.team.id), teamName: tm.team.name })
    teamsByProject.set(tm.team.projectId, list)
  }

  const projectsByOrganization = new Map<string, MeMembership['projects']>()
  for (const pm of projectMembers) {
    const list = projectsByOrganization.get(pm.project.organizationId) ?? []
    list.push({
      projectId: parseProjectId(pm.project.id),
      projectName: pm.project.name,
      teams: teamsByProject.get(pm.projectId) ?? [],
    })
    projectsByOrganization.set(pm.project.organizationId, list)
  }

  return orgMembers.map((om) => ({
    organizationId: parseOrganizationId(om.organization.id),
    organizationName: om.organization.name,
    role: om.role,
    projects: projectsByOrganization.get(om.organizationId) ?? [],
  }))
}

export const buildMeResponse = async (
  prisma: PrismaClient,
  user: User,
  claims: SessionTokenClaims,
  config: NessieConfig,
): Promise<MeResponse> => {
  const displayName = resolveStoredDisplayName(user.email, user.displayName)
  if (displayName !== user.displayName) {
    await prisma.user.update({
      where: { id: user.id },
      data: { displayName },
    })
  }

  const memberships = await loadUserMemberships(prisma, user.id)

  // Surface the live per-org role for the active context org so the admin's
  // client-side gating matches the server's now-authoritative role check
  // (authenticateRequest re-resolves actor.roles from the same membership): a
  // demoted owner immediately loses owner-only UI instead of seeing buttons that
  // 403. Fall back to the token claim for actors with no membership in this org.
  const activeOrgId = parseOrganizationId(claims.org)
  const activeRole = memberships.find(
    (membership) => membership.organizationId === activeOrgId,
  )?.role

  return {
    user: {
      id: parseUserId(user.id),
      email: user.email,
      displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      avatarAttachmentId: user.avatarAttachmentId ?? undefined,
      gravatarUrl: buildGravatarUrl(user.email),
      pronouns: user.pronouns ?? undefined,
      roleIds: activeRole ? [activeRole] : claims.roles,
      superAdmin: user.superAdmin,
      preferences: (user.preferences as Record<string, unknown> | null) ?? undefined,
    },
    session: {
      sessionId: claims.sid,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    },
    context: {
      organizationId: parseOrganizationId(claims.org),
      projectId: parseProjectId(claims.proj),
      teamId: parseTeamId(claims.team),
      channelId: null,
      bootstrapMode: false,
    },
    auth: {
      providerId: claims.providerId,
      providerType: claims.providerType,
      autoRedirectToSso: config.auth.autoRedirectToSso,
    },
    memberships,
  }
}
