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
  },
})

export const loadUserMemberships = async (
  prisma: PrismaClient,
  userId: string,
): Promise<MeMembership[]> => {
  const orgMembers = await prisma.organizationMember.findMany({
    where: { userId },
    include: {
      organization: { select: { id: true, name: true } },
    },
  })

  const memberships: MeMembership[] = []
  for (const om of orgMembers) {
    const projectMembers = await prisma.projectMember.findMany({
      where: { userId, project: { organizationId: om.organizationId } },
      include: {
        project: { select: { id: true, name: true } },
      },
    })

    const projects = await Promise.all(
      projectMembers.map(async (pm) => {
        const teamMembers = await prisma.teamMember.findMany({
          where: { userId, team: { projectId: pm.projectId } },
          include: {
            team: { select: { id: true, name: true } },
          },
        })
        return {
          projectId: parseProjectId(pm.project.id),
          projectName: pm.project.name,
          teams: teamMembers.map((tm) => ({
            teamId: parseTeamId(tm.team.id),
            teamName: tm.team.name,
          })),
        }
      }),
    )

    memberships.push({
      organizationId: parseOrganizationId(om.organization.id),
      organizationName: om.organization.name,
      role: om.role,
      projects,
    })
  }

  return memberships
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

  return {
    user: {
      id: parseUserId(user.id),
      email: user.email,
      displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      avatarAttachmentId: user.avatarAttachmentId ?? undefined,
      gravatarUrl: buildGravatarUrl(user.email),
      pronouns: user.pronouns ?? undefined,
      roleIds: claims.roles,
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
