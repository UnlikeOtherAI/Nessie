import type { User } from '@prisma/client'
import type { AuthProviderConfig, NessieConfig } from '@nessie/config'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  parseUserId,
  type AuthorizedActionContext,
  type AuthProviderResponseType,
  type MeResponse,
} from '@nessie/schemas'
import type { SessionTokenClaims } from '../auth/session.js'
import type { AuthProviderDescriptor } from '../contracts.js'

export const LOCAL_AUTH_PROVIDER_ID = 'local'

const LOCAL_AUTH_PROVIDER_LABEL = 'Email and password'

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

export const buildMeResponse = (
  user: User,
  claims: SessionTokenClaims,
  config: NessieConfig,
): MeResponse => ({
  user: {
    id: parseUserId(user.id),
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? undefined,
    pronouns: user.pronouns ?? undefined,
    roleIds: claims.roles,
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
})
