import { Prisma, type PrismaClient } from '@prisma/client'

export type SecretPermission = 'use' | 'reveal' | 'manage' | 'delegate'
export type SecretScopeType = 'personal' | 'team' | 'project' | 'organization'
type SecretRouteClient = PrismaClient | Prisma.TransactionClient

export const withSecretLifecycleLock = async <T>(
  prisma: PrismaClient,
  secretId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => prisma.$transaction(async (tx) => {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('nessie-secret-lifecycle'),
      hashtext(${secretId})
    )
  `
  return operation(tx)
}, { maxWait: 10_000, timeout: 75_000 })

export const canManageSecretScope = async (input: {
  actorId: string
  isOwner: boolean
  organizationId: string
  prisma: SecretRouteClient
  scopeId?: string
  scopeType: SecretScopeType
}): Promise<{ allowed: boolean; scopeId: string }> => {
  const { actorId, isOwner, organizationId, prisma, scopeType } = input
  if (scopeType === 'personal') return { allowed: true, scopeId: actorId }
  if (scopeType === 'organization') return { allowed: isOwner, scopeId: organizationId }
  if (!input.scopeId) return { allowed: false, scopeId: '' }
  if (scopeType === 'project') {
    const project = await prisma.project.findFirst({
      where: { id: input.scopeId, organizationId },
      select: { id: true },
    })
    return { allowed: isOwner && Boolean(project), scopeId: input.scopeId }
  }
  const team = await prisma.team.findFirst({
    where: { id: input.scopeId, project: { organizationId } },
    select: { id: true },
  })
  return { allowed: isOwner && Boolean(team), scopeId: input.scopeId }
}

export const secretGrantPrincipalExists = async (input: {
  organizationId: string
  principalId: string
  principalType: 'user' | 'agent' | 'team' | 'project' | 'organization'
  prisma: SecretRouteClient
}): Promise<boolean> => {
  const { organizationId, principalId, principalType, prisma } = input
  if (principalType === 'organization') return principalId === organizationId
  if (principalType === 'user') {
    return Boolean(await prisma.organizationMember.findFirst({
      where: { organizationId, userId: principalId, deactivatedAt: null },
      select: { id: true },
    }))
  }
  if (principalType === 'agent') {
    return Boolean(await prisma.agent.findFirst({
      where: { id: principalId, organizationId }, select: { id: true },
    }))
  }
  if (principalType === 'project') {
    return Boolean(await prisma.project.findFirst({
      where: { id: principalId, organizationId }, select: { id: true },
    }))
  }
  return Boolean(await prisma.team.findFirst({
    where: { id: principalId, project: { organizationId } }, select: { id: true },
  }))
}

export const hasSecretPermission = async (input: {
  actorId: string
  permission: SecretPermission
  prisma: SecretRouteClient
  secretId: string
}): Promise<boolean> => Boolean(await input.prisma.secretGrant.findFirst({
  where: {
    secretId: input.secretId,
    principalType: 'user',
    principalId: input.actorId,
    permissions: { has: input.permission },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  },
  select: { id: true },
}))

export type SecretDelegationAuthority = { expiresAt: Date | null }

/** Delegation never mints a capability or lifetime the delegating user does not hold. */
export const secretDelegationAuthority = async (input: {
  actorId: string
  permissions: SecretPermission[]
  prisma: SecretRouteClient
  secretId: string
}): Promise<SecretDelegationAuthority | null> => {
  const required = [...new Set<SecretPermission>(['delegate', ...input.permissions])]
  const grant = await input.prisma.secretGrant.findFirst({
    where: {
      secretId: input.secretId,
      principalType: 'user',
      principalId: input.actorId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { expiresAt: true, permissions: true },
  })
  if (!grant) return null
  const held = new Set(grant.permissions as SecretPermission[])
  return required.every((permission) => held.has(permission))
    ? { expiresAt: grant.expiresAt }
    : null
}
