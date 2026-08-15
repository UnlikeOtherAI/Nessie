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

export const LOCAL_AUTH_PROVIDER_ID = 'local'

const LOCAL_AUTH_PROVIDER_LABEL = 'Email and password'

const UOA_DEFAULT_BASE_URL = 'https://authentication.unlikeotherai.com'

const resolveUoaBaseUrl = (): string =>
  (process.env.UOA_BASE_URL ?? UOA_DEFAULT_BASE_URL).replace(/\/$/, '')

// The public-facing URL of the authenticator behind a provider, shown in the
// profile. OIDC/custom carry it in config; UOA's lives in the UOA_BASE_URL env
// (with the same default the worker uses), not the per-provider config block.
const resolveProviderUrl = (provider: AuthProviderConfig): string | undefined => {
  if (provider.issuerUrl) {
    return provider.issuerUrl
  }
  if (provider.type === 'uoa') {
    return resolveUoaBaseUrl()
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
    pushRegistrationVersion: claims.pv ?? '0',
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

const parseHttpUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

const uoaWorkspaceAvatarImageUrl = (teamId: string, value: unknown): string | undefined => {
  const supplied = parseHttpUrl(value)
  const fallbackBase = supplied ? undefined : parseHttpUrl(resolveUoaBaseUrl())
  if (!supplied && !fallbackBase) return undefined

  const url = new URL(
    supplied ?? `/teams/${encodeURIComponent(teamId)}/avatar`,
    fallbackBase,
  )
  // This supported UOA image parameter gives sessions created before avatar URLs were added a
  // deterministic URL and avoids reusing a browser-cached pre-embedding-policy response.
  url.searchParams.set('size', '128')
  return url.toString()
}

const uoaWorkspaceDirectoryFromMetadata = (
  metadata: unknown,
  activeTeamId: string | undefined,
): MeResponse['uoaWorkspaces'] => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const entries = (metadata as Record<string, unknown>).workspaceDirectory
  if (!Array.isArray(entries)) return undefined
  const workspaces = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const values = entry as Record<string, unknown>
    const organizationId = typeof values.organizationId === 'string' ? values.organizationId.trim() : ''
    const teamId = typeof values.teamId === 'string' ? values.teamId.trim() : ''
    const label = typeof values.label === 'string' ? values.label.trim() : ''
    const orgName = typeof values.orgName === 'string' ? values.orgName.trim() : ''
    if (!organizationId || !teamId || !label) return []
    const avatarImageUrl = uoaWorkspaceAvatarImageUrl(teamId, values.avatarImageUrl)
    return [{
      organizationId,
      teamId,
      ...(avatarImageUrl ? { avatarImageUrl } : {}),
      label,
      ...(orgName ? { orgName } : {}),
      active: teamId === activeTeamId,
    }]
  })
  return workspaces.length > 0 ? workspaces : undefined
}

// UOA's directory identifies workspaces with the external team id used for
// login. The avatar relay intentionally accepts only a local Team id and checks
// a live TeamMember row, so add that id only for workspaces this person can
// already reach in Nessie. This keeps every picker image entitlement-scoped.
const addWorkspaceAvatarTeamIds = async (
  prisma: PrismaClient,
  userId: string,
  workspaces: NonNullable<MeResponse['uoaWorkspaces']>,
): Promise<MeResponse['uoaWorkspaces']> => {
  const externalWorkspaceIds = [...new Set(workspaces.map((workspace) => workspace.teamId))]
  const teams = await prisma.team.findMany({
    where: {
      externalWorkspaceId: { in: externalWorkspaceIds },
      members: { some: { userId } },
    },
    select: { externalWorkspaceId: true, id: true },
  })
  const localTeamIds = new Map(
    teams.flatMap((team) => team.externalWorkspaceId
      ? [[team.externalWorkspaceId, parseTeamId(team.id)] as const]
      : []),
  )

  return workspaces.map((workspace) => {
    const avatarTeamId = localTeamIds.get(workspace.teamId)
    return avatarTeamId ? { ...workspace, avatarTeamId } : workspace
  })
}

const loadUoaWorkspaceDirectory = async (
  prisma: PrismaClient,
  userId: string,
  claims: SessionTokenClaims,
): Promise<MeResponse['uoaWorkspaces']> => {
  if (claims.providerType !== 'uoa') return undefined
  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: claims.org,
        userId,
        productSlug: 'nessie',
      },
    },
    select: { metadata: true },
  })
  const workspaces = uoaWorkspaceDirectoryFromMetadata(
    link?.metadata,
    claims.uoaIdentity?.teamId,
  )
  return workspaces ? addWorkspaceAvatarTeamIds(prisma, userId, workspaces) : undefined
}

export const buildMeResponse = async (
  prisma: PrismaClient,
  user: User,
  claims: SessionTokenClaims,
  config: NessieConfig,
): Promise<MeResponse> => {
  // The profile is read straight off the mirror. This used to manufacture a
  // display name from the email local part and persist it on every call, which
  // made Nessie a second profile authority; the mirror is now re-synced from
  // the provider's verified claims at login/switch/refresh instead
  // (`uoa-profile-mirror.ts`), and a row still named by its email address
  // renders that way until the provider supplies a name.
  const [memberships, uoaWorkspaces] = await Promise.all([
    loadUserMemberships(prisma, user.id),
    loadUoaWorkspaceDirectory(prisma, user.id, claims),
  ])

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
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      avatarAttachmentId: user.avatarAttachmentId ?? undefined,
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
    ...(uoaWorkspaces ? { uoaWorkspaces } : {}),
  }
}
