import type { PrismaClient } from '@prisma/client'

export type SecretPermission = 'use' | 'reveal' | 'manage' | 'delegate'
export type SecretScopeType = 'personal' | 'team' | 'project' | 'organization'

export const canManageSecretScope = async (input: {
  actorId: string
  isOwner: boolean
  organizationId: string
  prisma: PrismaClient
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
  prisma: PrismaClient
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
  prisma: PrismaClient
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

/** Delegation never mints a capability the delegating user does not hold. */
export const hasEverySecretPermission = async (input: {
  actorId: string
  permissions: SecretPermission[]
  prisma: PrismaClient
  secretId: string
}): Promise<boolean> => {
  const required = [...new Set<SecretPermission>(['delegate', ...input.permissions])]
  const grant = await input.prisma.secretGrant.findFirst({
    where: {
      secretId: input.secretId,
      principalType: 'user',
      principalId: input.actorId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { permissions: true },
  })
  if (!grant) return false
  const held = new Set(grant.permissions as SecretPermission[])
  return required.every((permission) => held.has(permission))
}
