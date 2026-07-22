import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  issueSessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { LOCAL_AUTH_PROVIDER_ID } from './auth.js'

/** Build fresh or renewed access sessions from authoritative local context. */
export const createSessionIssuers = (input: {
  authSecret: string
  defaultProviderType: SessionTokenClaims['providerType']
  prisma: PrismaClient
  tokenTtlSeconds: number
}) => {
  const buildLocalSession = async (
    userId: string,
    roles: string[],
    provider?: {
      providerId: string
      providerType: SessionTokenClaims['providerType']
    },
    // A refresh keeps the stable session id; a fresh login mints a new one.
    sessionId?: string,
    uoaIdentity?: UoaSessionIdentity,
  ) => {
    const user = await input.prisma.user.findUnique({
      where: { id: userId },
      include: {
        organizationMembers: {
          orderBy: { createdAt: 'asc' },
          select: { organizationId: true, role: true },
        },
        projectMembers: {
          orderBy: { createdAt: 'asc' },
          select: { projectId: true },
        },
        teamMembers: {
          orderBy: { createdAt: 'asc' },
          select: { teamId: true },
        },
      },
    })

    const organizationId = user?.organizationMembers[0]?.organizationId
      ?? DEFAULT_BOOTSTRAP_RECORD_IDS.organizationId
    const projectId = user?.projectMembers[0]?.projectId
      ?? DEFAULT_BOOTSTRAP_RECORD_IDS.projectId
    const teamId = user?.teamMembers[0]?.teamId
      ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId
    const resolvedRoles = roles.length > 0
      ? roles
      : [user?.organizationMembers[0]?.role ?? 'member']

    return issueSessionToken(
      {
        sub: userId,
        org: organizationId,
        proj: projectId,
        team: teamId,
        roles: resolvedRoles,
        providerId: provider?.providerId ?? LOCAL_AUTH_PROVIDER_ID,
        providerType: provider?.providerType ?? input.defaultProviderType,
        ...(uoaIdentity ? { uoaIdentity } : {}),
      },
      input.authSecret,
      input.tokenTtlSeconds,
      sessionId,
    )
  }

  const buildSessionForUser = (session: {
    organizationId: string
    projectId: string
    providerId: string
    providerType: SessionTokenClaims['providerType']
    roles: string[]
    sessionId?: string
    teamId: string
    uoaIdentity?: UoaSessionIdentity
    userId: string
  }) => issueSessionToken(
    {
      sub: session.userId,
      org: session.organizationId,
      proj: session.projectId,
      team: session.teamId,
      roles: session.roles,
      providerId: session.providerId,
      providerType: session.providerType,
      ...(session.uoaIdentity ? { uoaIdentity: session.uoaIdentity } : {}),
    },
    input.authSecret,
    input.tokenTtlSeconds,
    session.sessionId,
  )

  return { buildLocalSession, buildSessionForUser }
}
