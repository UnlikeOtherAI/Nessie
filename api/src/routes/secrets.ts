import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  InfisicalVault,
  InfisicalVaultError,
  type InfisicalSecretNamespace,
} from '../services/infisical-vault.js'
import {
  canManageSecretScope,
  putSecretInVault,
  SecretScopeSchema,
  vaultSecretName,
} from '../services/secret-vault-write.js'
import type { RouteDeps } from './types.js'

const CreateSecretBodySchema = z.object({
  name: z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/, 'Use an environment-variable-style name.'),
  value: z.string().min(1).max(65_536),
  description: z.string().trim().max(1_000).optional(),
  provider: z.string().trim().max(120).optional(),
  scopeType: SecretScopeSchema,
  scopeId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict()

const RotateSecretBodySchema = z.object({ value: z.string().min(1).max(65_536) }).strict()

const GrantSecretBodySchema = z.object({
  principalType: z.enum(['user', 'agent', 'team', 'project', 'organization']),
  principalId: z.string().uuid(),
  permissions: z.array(z.enum(['use', 'reveal', 'manage', 'delegate'])).min(1),
  expiresAt: z.string().datetime().optional(),
}).strict()

const publicSecret = (secret: {
  reference: string
  name: string
  description: string | null
  provider: string | null
  scopeType: string
  scopeId: string
  rotatedAt: Date | null
  expiresAt: Date | null
  status: string
  createdAt: Date
  updatedAt: Date
}) => ({
  reference: secret.reference,
  name: secret.name,
  description: secret.description,
  provider: secret.provider,
  scopeType: secret.scopeType,
  scopeId: secret.scopeId,
  rotatedAt: secret.rotatedAt?.toISOString() ?? null,
  expiresAt: secret.expiresAt?.toISOString() ?? null,
  status: secret.status,
  createdAt: secret.createdAt.toISOString(),
  updatedAt: secret.updatedAt.toISOString(),
})

const sendVaultError = (reply: Parameters<typeof sendApiError>[0], error: unknown): boolean => {
  if (!(error instanceof InfisicalVaultError)) return false
  sendApiError(
    reply,
    error.code === 'NOT_CONFIGURED' ? 503 : 502,
    error.code === 'NOT_CONFIGURED' ? 'SECRETS_NOT_CONFIGURED' : 'VAULT_UNAVAILABLE',
    error.message,
  )
  return true
}

const grantPrincipalExistsInOrganization = async (input: {
  organizationId: string
  principalId: string
  principalType: z.infer<typeof GrantSecretBodySchema>['principalType']
  prisma: RouteDeps['prisma']
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
      where: { id: principalId, organizationId },
      select: { id: true },
    }))
  }
  if (principalType === 'project') {
    return Boolean(await prisma.project.findFirst({
      where: { id: principalId, organizationId },
      select: { id: true },
    }))
  }
  return Boolean(await prisma.team.findFirst({
    where: { id: principalId, project: { organizationId } },
    select: { id: true },
  }))
}

const hasSecretPermission = async (input: {
  actorId: string
  permission: 'manage' | 'delegate'
  prisma: RouteDeps['prisma']
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

/** Metadata-only human control plane. Agents have no reveal endpoint. */
export const registerSecretRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.get('/api/secrets', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    const secrets = await prisma.secret.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        ...(isOwner ? {} : {
          OR: [
            { scopeType: 'personal', scopeId: actorContext.actor.actorId },
            {
              grants: {
                some: {
                  principalType: 'user',
                  principalId: actorContext.actor.actorId,
                  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
              },
            },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
    })
    return createApiResponse(secrets.map(publicSecret))
  })

  app.post('/api/secrets', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'SECRET_HUMAN_ONLY', 'Only a signed-in person can save a secret.')
      return reply
    }
    const body = parseInput(CreateSecretBodySchema, request.body, reply)
    if (!body) return reply
    const scope = await canManageSecretScope({
      actorId: actorContext.actor.actorId,
      isOwner: actorContext.actor.roles?.includes('owner') ?? false,
      organizationId: actorContext.tenant.organizationId,
      prisma,
      ...(body.scopeId === undefined ? {} : { scopeId: body.scopeId }),
      scopeType: body.scopeType,
    })
    if (!scope.allowed) {
      sendApiError(reply, 403, 'SECRET_SCOPE_DENIED', 'You cannot manage secrets in this scope.')
      return reply
    }

    const namespace: InfisicalSecretNamespace = {
      organizationId: actorContext.tenant.organizationId,
      scopeId: scope.scopeId,
      scopeType: body.scopeType,
    }
    let written: Awaited<ReturnType<typeof putSecretInVault>>
    try {
      written = await putSecretInVault({
        ...(body.description === undefined ? {} : { description: body.description }),
        namespace,
        value: body.value,
      })
    } catch (error) {
      if (sendVaultError(reply, error)) return reply
      throw error
    }
    const { reference, vaultReference } = written
    let secret
    try {
      secret = await prisma.secret.create({
        data: {
          createdById: actorContext.actor.actorId,
          description: body.description,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
          name: body.name,
          organizationId: actorContext.tenant.organizationId,
          provider: body.provider,
          reference,
          scopeId: scope.scopeId,
          scopeType: body.scopeType,
          vaultReference,
        },
      })
    } catch (error) {
      // Never retain a usable vault value when its Nessie metadata row failed.
      await written.rollback()
      throw error
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'secret.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceId: secret.id,
      resourceType: 'secret',
      outcome: 'success',
      metadata: { reference: secret.reference, scopeType: secret.scopeType },
    })
    return reply.code(201).send(createApiResponse(publicSecret(secret)))
  })

  app.post('/api/secrets/:reference/rotate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'SECRET_HUMAN_ONLY', 'Only a signed-in person can manage a secret.')
      return reply
    }
    const body = parseInput(RotateSecretBodySchema, request.body, reply)
    if (!body) return reply
    const secret = await prisma.secret.findFirst({
      where: {
        organizationId: actorContext.tenant.organizationId,
        reference: (request.params as { reference: string }).reference,
      },
    })
    if (!secret) {
      sendApiError(reply, 404, 'SECRET_NOT_FOUND', 'Secret not found.')
      return reply
    }
    const canManage = actorContext.actor.roles?.includes('owner')
      || (secret.scopeType === 'personal' && secret.scopeId === actorContext.actor.actorId)
      || await hasSecretPermission({
        actorId: actorContext.actor.actorId,
        permission: 'manage',
        prisma,
        secretId: secret.id,
      })
    if (!canManage) {
      sendApiError(reply, 403, 'SECRET_MANAGE_DENIED', 'You cannot manage this secret.')
      return reply
    }
    const namespace: InfisicalSecretNamespace = {
      organizationId: secret.organizationId,
      scopeId: secret.scopeId,
      scopeType: secret.scopeType,
    }
    try {
      await new InfisicalVault().replace({
        name: vaultSecretName(secret.reference),
        namespace,
        value: body.value,
      })
    } catch (error) {
      if (sendVaultError(reply, error)) return reply
      throw error
    }
    const rotated = await prisma.secret.update({
      where: { id: secret.id }, data: { rotatedAt: new Date(), status: 'active' },
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'secret.rotated' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceId: secret.id,
      resourceType: 'secret',
      outcome: 'success',
      metadata: { reference: secret.reference },
    })
    return createApiResponse(publicSecret(rotated))
  })

  app.post('/api/secrets/:reference/revoke', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'SECRET_HUMAN_ONLY', 'Only a signed-in person can manage a secret.')
      return reply
    }
    const secret = await prisma.secret.findFirst({
      where: {
        organizationId: actorContext.tenant.organizationId,
        reference: (request.params as { reference: string }).reference,
      },
    })
    if (!secret) {
      sendApiError(reply, 404, 'SECRET_NOT_FOUND', 'Secret not found.')
      return reply
    }
    const canManage = actorContext.actor.roles?.includes('owner')
      || (secret.scopeType === 'personal' && secret.scopeId === actorContext.actor.actorId)
      || await hasSecretPermission({
        actorId: actorContext.actor.actorId,
        permission: 'manage',
        prisma,
        secretId: secret.id,
      })
    if (!canManage) {
      sendApiError(reply, 403, 'SECRET_MANAGE_DENIED', 'You cannot manage this secret.')
      return reply
    }
    const namespace: InfisicalSecretNamespace = {
      organizationId: secret.organizationId,
      scopeId: secret.scopeId,
      scopeType: secret.scopeType,
    }
    try {
      await new InfisicalVault().remove({ name: vaultSecretName(secret.reference), namespace })
    } catch (error) {
      if (sendVaultError(reply, error)) return reply
      throw error
    }
    const revoked = await prisma.secret.update({ where: { id: secret.id }, data: { status: 'revoked' } })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'secret.revoked' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceId: secret.id,
      resourceType: 'secret',
      outcome: 'success',
      metadata: { reference: secret.reference },
    })
    return createApiResponse(publicSecret(revoked))
  })

  app.post('/api/secrets/:reference/grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'SECRET_HUMAN_ONLY', 'Only a signed-in person can manage a secret.')
      return reply
    }
    const body = parseInput(GrantSecretBodySchema, request.body, reply)
    if (!body) return reply
    if (body.principalType === 'agent' && body.permissions.some((permission) => permission !== 'use')) {
      sendApiError(
        reply,
        400,
        'AGENT_SECRET_PERMISSION_FORBIDDEN',
        'Agents may receive USE permission only; they can never reveal, manage, or delegate secrets.',
      )
      return reply
    }
    const secret = await prisma.secret.findFirst({
      where: {
        organizationId: actorContext.tenant.organizationId,
        reference: (request.params as { reference: string }).reference,
      },
    })
    if (!secret) {
      sendApiError(reply, 404, 'SECRET_NOT_FOUND', 'Secret not found.')
      return reply
    }
    const canDelegate = actorContext.actor.roles?.includes('owner')
      || (secret.scopeType === 'personal' && secret.scopeId === actorContext.actor.actorId)
      || await hasSecretPermission({
        actorId: actorContext.actor.actorId,
        permission: 'delegate',
        prisma,
        secretId: secret.id,
      })
    if (!canDelegate) {
      sendApiError(reply, 403, 'SECRET_DELEGATE_DENIED', 'You cannot delegate access to this secret.')
      return reply
    }
    if (!(await grantPrincipalExistsInOrganization({
      organizationId: actorContext.tenant.organizationId,
      principalId: body.principalId,
      principalType: body.principalType,
      prisma,
    }))) {
      sendApiError(reply, 400, 'SECRET_GRANT_PRINCIPAL_INVALID', 'The grant target is not in this team.')
      return reply
    }
    const grant = await prisma.secretGrant.upsert({
      where: {
        secretId_principalType_principalId: {
          principalId: body.principalId,
          principalType: body.principalType,
          secretId: secret.id,
        },
      },
      create: {
        ...body,
        createdById: actorContext.actor.actorId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        secretId: secret.id,
      },
      update: {
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        permissions: body.permissions,
      },
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'secret.access_granted' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceId: secret.id,
      resourceType: 'secret',
      outcome: 'success',
      metadata: { principalType: grant.principalType, reference: secret.reference },
    })
    return createApiResponse({ ...grant, expiresAt: grant.expiresAt?.toISOString() ?? null })
  })
}
