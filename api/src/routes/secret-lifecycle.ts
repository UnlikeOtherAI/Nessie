import type { PrismaClient, Secret, SecretGrant } from '@prisma/client'

import {
  InfisicalVault,
  type InfisicalSecretNamespace,
} from '../services/infisical-vault.js'
import {
  hasSecretPermission,
  secretDelegationAuthority,
  secretGrantPrincipalExists,
  type SecretPermission,
  withSecretLifecycleLock,
} from './secret-route-access.js'

type SecretActor = {
  actorId: string
  isOwner: boolean
  organizationId: string
}

export type SecretLifecycleFailure =
  | 'denied'
  | 'inactive'
  | 'invalid_principal'
  | 'missing'

export type SecretLifecycleResult<T> =
  | { changed?: boolean; ok: true; value: T }
  | { ok: false; reason: SecretLifecycleFailure }

const vaultName = (reference: string): string => `NESSIE_${reference.slice(4).toUpperCase()}`

const namespaceFor = (secret: Secret): InfisicalSecretNamespace => ({
  organizationId: secret.organizationId,
  scopeId: secret.scopeId,
  scopeType: secret.scopeType,
})

const canManageSecret = async (
  prisma: Parameters<typeof hasSecretPermission>[0]['prisma'],
  actor: SecretActor,
  secret: Secret,
): Promise<boolean> => actor.isOwner
  || (secret.scopeType === 'personal' && secret.scopeId === actor.actorId)
  || hasSecretPermission({
    actorId: actor.actorId,
    permission: 'manage',
    prisma,
    secretId: secret.id,
  })

export const rotateActiveSecret = async (input: {
  actor: SecretActor
  prisma: PrismaClient
  secretId: string
  value: string
}): Promise<SecretLifecycleResult<Secret>> => withSecretLifecycleLock(
  input.prisma,
  input.secretId,
  async (tx) => {
    const secret = await tx.secret.findFirst({
      where: { id: input.secretId, organizationId: input.actor.organizationId },
    })
    if (!secret) return { ok: false, reason: 'missing' }
    if (!(await canManageSecret(tx, input.actor, secret))) {
      return { ok: false, reason: 'denied' }
    }
    if (secret.status !== 'active') return { ok: false, reason: 'inactive' }
    await new InfisicalVault().replace({
      name: vaultName(secret.reference),
      namespace: namespaceFor(secret),
      value: input.value,
    })
    const value = await tx.secret.update({
      where: { id: secret.id },
      data: { rotatedAt: new Date() },
    })
    return { ok: true, value }
  },
)

export const revokeActiveSecret = async (input: {
  actor: SecretActor
  prisma: PrismaClient
  secretId: string
}): Promise<SecretLifecycleResult<Secret>> => withSecretLifecycleLock(
  input.prisma,
  input.secretId,
  async (tx) => {
    const secret = await tx.secret.findFirst({
      where: { id: input.secretId, organizationId: input.actor.organizationId },
    })
    if (!secret) return { ok: false, reason: 'missing' }
    if (!(await canManageSecret(tx, input.actor, secret))) {
      return { ok: false, reason: 'denied' }
    }
    if (secret.status === 'revoked') return { changed: false, ok: true, value: secret }
    if (secret.status !== 'active') return { ok: false, reason: 'inactive' }
    await new InfisicalVault().remove({
      name: vaultName(secret.reference),
      namespace: namespaceFor(secret),
    })
    const value = await tx.secret.update({
      where: { id: secret.id },
      data: { status: 'revoked' },
    })
    return { changed: true, ok: true, value }
  },
)

type GrantInput = {
  expiresAt?: string
  permissions: SecretPermission[]
  principalId: string
  principalType: 'user' | 'agent' | 'team' | 'project' | 'organization'
}

export const grantActiveSecret = async (input: {
  actor: SecretActor
  body: GrantInput
  prisma: PrismaClient
  secretId: string
}): Promise<SecretLifecycleResult<SecretGrant>> => withSecretLifecycleLock(
  input.prisma,
  input.secretId,
  async (tx) => {
    const secret = await tx.secret.findFirst({
      where: { id: input.secretId, organizationId: input.actor.organizationId },
    })
    if (!secret) return { ok: false, reason: 'missing' }

    const hasUnlimitedAuthority = input.actor.isOwner
      || (secret.scopeType === 'personal' && secret.scopeId === input.actor.actorId)
    if (!hasUnlimitedAuthority) {
      const authority = await secretDelegationAuthority({
        actorId: input.actor.actorId,
        permissions: input.body.permissions,
        prisma: tx,
        secretId: secret.id,
      })
      const requestedExpiry = input.body.expiresAt ? new Date(input.body.expiresAt) : null
      if (
        !authority
        || (authority.expiresAt
          && (!requestedExpiry || requestedExpiry > authority.expiresAt))
      ) {
        return { ok: false, reason: 'denied' }
      }
    }
    if (secret.status !== 'active') return { ok: false, reason: 'inactive' }
    if (!(await secretGrantPrincipalExists({
      organizationId: input.actor.organizationId,
      principalId: input.body.principalId,
      principalType: input.body.principalType,
      prisma: tx,
    }))) {
      return { ok: false, reason: 'invalid_principal' }
    }
    const value = await tx.secretGrant.upsert({
      where: {
        secretId_principalType_principalId: {
          principalId: input.body.principalId,
          principalType: input.body.principalType,
          secretId: secret.id,
        },
      },
      create: {
        ...input.body,
        createdById: input.actor.actorId,
        expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : undefined,
        secretId: secret.id,
      },
      update: {
        expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : null,
        permissions: input.body.permissions,
      },
    })
    return { ok: true, value }
  },
)
