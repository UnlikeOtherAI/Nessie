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

import { findSecretLockAbove } from '@nessie/schemas'
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

/**
 * Every scope id a person stands inside, for the scopes above `personal`.
 *
 * A lock binds the whole subtree beneath it, and a person is in many teams, so
 * "which locks could bind me" is never answerable from the session's *active*
 * team alone. Team and project membership are read separately rather than
 * derived from one another: the `Team.projectId` foreign key points the
 * opposite way to the model this product is written for
 * (docs/standards/team-model.md), so joining through it would silently drop
 * one of the two.
 */
const scopeIdsForActor = async (input: {
  actorId: string
  organizationId: string
  prisma: Pick<PrismaClient, 'projectMember' | 'teamMember'>
}): Promise<{ projectIds: string[]; teamIds: string[] }> => {
  const [teams, projects] = await Promise.all([
    input.prisma.teamMember.findMany({
      select: { teamId: true },
      where: { userId: input.actorId, team: { project: { organizationId: input.organizationId } } },
    }),
    input.prisma.projectMember.findMany({
      select: { projectId: true },
      where: { userId: input.actorId, project: { organizationId: input.organizationId } },
    }),
  ])
  return {
    projectIds: projects.map((row) => row.projectId),
    teamIds: teams.map((row) => row.teamId),
  }
}

/**
 * The one Prisma access `hasSecretPermission`/`canManageSecret` need — narrow
 * on purpose (rather than `Pick<PrismaClient, 'secretGrant'>`) so a unit test
 * can fake it with a single function instead of the full generated delegate.
 */
export type SecretGrantLookup = {
  secretGrant: {
    findFirst: (args: {
      where: {
        secretId: string
        principalType: 'user'
        principalId: string
        permissions: { has: 'manage' | 'delegate' }
        OR: Array<{ expiresAt: null } | { expiresAt: { gt: Date } }>
      }
      select: { id: true }
    }) => Promise<{ id: string } | null>
  }
}

/**
 * Whether the actor holds an explicit, unexpired `SecretGrant` for
 * `permission` on this secret. Never true for `use` here — that permission
 * only gates value retrieval, not the management endpoints that call this.
 */
export const hasSecretPermission = async (input: {
  actorId: string
  permission: 'manage' | 'delegate'
  prisma: SecretGrantLookup
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

/**
 * The one access-control predicate for rotating, revoking, or delegating a
 * secret: an organisation owner, the person who owns a `personal`-scope
 * secret, or someone holding an explicit grant for `permission`. Composed
 * once here so the three route handlers that gate on it cannot drift.
 */
export const canManageSecret = async (
  actorContext: { actor: { actorId: string; roles?: string[] | null } },
  secret: { id: string; scopeType: SecretScope; scopeId: string },
  permission: 'manage' | 'delegate',
  prisma: SecretGrantLookup,
): Promise<boolean> =>
  actorContext.actor.roles?.includes('owner') === true
  || (secret.scopeType === 'personal' && secret.scopeId === actorContext.actor.actorId)
  || await hasSecretPermission({
    actorId: actorContext.actor.actorId,
    permission,
    prisma,
    secretId: secret.id,
  })

/**
 * The secrets a person may see the *metadata* of: their own, everything
 * explicitly granted to them, and — because a cascade a person cannot see is
 * not a cascade they can work with — the organisation's plus every team and
 * project they belong to.
 *
 * Widening this to the levels above was the price of showing precedence and
 * locks on a member's own Secrets page: without it a person's personal secret
 * silently stopped applying and the screen had nothing to say about why. No
 * value, ciphertext or vault path is exposed by any of it — a `Secret` row
 * holds none (docs/secret-management-spec.md → "Authority split") — and use of
 * a secret still runs through `SecretGrant`, which this does not touch.
 */
export const secretsVisibleToActor = async (input: {
  actorId: string
  isOwner: boolean
  organizationId: string
  prisma: Pick<PrismaClient, 'projectMember' | 'secret' | 'teamMember'>
}) => {
  const where = input.isOwner
    ? { organizationId: input.organizationId }
    : await (async () => {
      const { projectIds, teamIds } = await scopeIdsForActor(input)
      return {
        organizationId: input.organizationId,
        OR: [
          { scopeType: 'organization' as const },
          { scopeType: 'personal' as const, scopeId: input.actorId },
          ...(teamIds.length ? [{ scopeType: 'team' as const, scopeId: { in: teamIds } }] : []),
          ...(projectIds.length
            ? [{ scopeType: 'project' as const, scopeId: { in: projectIds } }]
            : []),
          {
            grants: {
              some: {
                principalType: 'user' as const,
                principalId: input.actorId,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            },
          },
        ],
      }
    })()
  return input.prisma.secret.findMany({ where, orderBy: { createdAt: 'desc' } })
}

/**
 * The broadest active lock on `name` sitting strictly above the scope being
 * written, or null when the write is free to proceed.
 *
 * The candidate set is deliberately every scope the *actor* stands in rather
 * than the one chain their session happens to be pointed at: a person writing
 * a personal secret is bound by a lock in any of their teams, and an owner
 * writing into one team is bound by the organisation's.
 */
export const findLockAboveScope = async (input: {
  actorId: string
  name: string
  organizationId: string
  prisma: Pick<PrismaClient, 'projectMember' | 'secret' | 'teamMember'>
  scopeType: SecretScope
}): Promise<{ reference: string; scopeType: SecretScope } | null> => {
  if (input.scopeType === 'organization') return null
  // Nothing sits above a team but the organisation, which every write consults
  // anyway; only a personal or project write has to ask about memberships.
  const { projectIds, teamIds } = input.scopeType === 'team'
    ? { projectIds: [], teamIds: [] }
    : await scopeIdsForActor(input)
  const candidateScopes = [
    { scopeType: 'organization' as const },
    ...(teamIds.length ? [{ scopeType: 'team' as const, scopeId: { in: teamIds } }] : []),
    ...(projectIds.length ? [{ scopeType: 'project' as const, scopeId: { in: projectIds } }] : []),
  ]
  const rows = await input.prisma.secret.findMany({
    select: { locked: true, name: true, reference: true, scopeId: true, scopeType: true },
    where: {
      locked: true,
      name: input.name,
      organizationId: input.organizationId,
      status: 'active',
      OR: candidateScopes,
    },
  })
  const lock = findSecretLockAbove(
    { name: input.name, scopeType: input.scopeType },
    rows.map((row) => ({ ...row, status: 'active' as const })),
  )
  return lock ? { reference: lock.reference, scopeType: lock.scopeType } : null
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
