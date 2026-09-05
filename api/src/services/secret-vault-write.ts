/**
 * The one way a person's secret reaches the vault.
 *
 * `POST /api/secrets` and an agent card's `vault_secret` press are the same
 * operation reached through two doors, so the scope authorization and the
 * vault/metadata write order live here rather than being mirrored twice. The
 * order matters and is not obvious: the vault write happens first and the
 * Prisma row second, because a metadata row pointing at nothing is a broken
 * secret a person can see and retry, while vault material with no row is
 * unreachable and unrotatable. `rollback` exists for exactly that window.
 */

import crypto from 'node:crypto'

import { z } from 'zod'

import {
  InfisicalVault,
  type InfisicalSecretNamespace,
} from './infisical-vault.js'
import type { PrismaClient } from '@prisma/client'

export const SecretScopeSchema = z.enum(['personal', 'team', 'project', 'organization'])
export type SecretScope = z.infer<typeof SecretScopeSchema>

/** The vault path for a Nessie secret reference. Never a display name. */
export const vaultSecretName = (reference: string): string =>
  `NESSIE_${reference.slice(4).toUpperCase()}`

/**
 * Who may save a secret into a scope. Personal is always the actor's own;
 * every wider scope is owner-only and must resolve to a real row in this
 * organisation, so a scopeId from an agent-authored card cannot reach across
 * tenants.
 */
export const canManageSecretScope = async (input: {
  actorId: string
  isOwner: boolean
  organizationId: string
  prisma: Pick<PrismaClient, 'project' | 'team'>
  scopeId?: string
  scopeType: SecretScope
}): Promise<{ allowed: boolean; scopeId: string }> => {
  const { actorId, isOwner, organizationId, prisma, scopeType } = input
  if (scopeType === 'personal') return { allowed: true, scopeId: actorId }
  if (scopeType === 'organization') return { allowed: isOwner, scopeId: organizationId }
  if (!input.scopeId) return { allowed: false, scopeId: '' }
  if (scopeType === 'project') {
    const project = await prisma.project.findFirst({
      select: { id: true },
      where: { id: input.scopeId, organizationId },
    })
    return { allowed: isOwner && Boolean(project), scopeId: input.scopeId }
  }
  const team = await prisma.team.findFirst({
    select: { id: true },
    where: { id: input.scopeId, project: { organizationId } },
  })
  return { allowed: isOwner && Boolean(team), scopeId: input.scopeId }
}

export type VaultSecretWrite = {
  reference: string
  vaultReference: string
  /** Remove the vault material when its metadata row could not be written. */
  rollback: () => Promise<void>
}

/**
 * Put a value in the vault and hand back the references its metadata row
 * needs. The caller writes that row and calls `rollback` if it cannot.
 * Throws `InfisicalVaultError` when no vault is configured or reachable.
 */
export const putSecretInVault = async (input: {
  description?: string
  namespace: InfisicalSecretNamespace
  value: string
}): Promise<VaultSecretWrite> => {
  const reference = `sec_${crypto.randomBytes(16).toString('hex')}`
  const vault = new InfisicalVault()
  const vaultReference = await vault.put({
    ...(input.description === undefined ? {} : { description: input.description }),
    name: vaultSecretName(reference),
    namespace: input.namespace,
    value: input.value,
  })
  return {
    reference,
    vaultReference,
    rollback: async () => {
      await vault
        .remove({ name: vaultSecretName(reference), namespace: input.namespace })
        .catch(() => undefined)
    },
  }
}
