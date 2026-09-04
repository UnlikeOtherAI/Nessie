import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  InfisicalVault,
  InfisicalVaultError,
  type InfisicalSecretNamespace,
} from '../services/infisical-vault.js'
import {
  secretMetadataIsUnsafe,
  secretReferenceForCapture,
} from './secret-capture-idempotency.js'
import {
  createSecretCapture,
  SecretCaptureIdempotencyConflict,
} from './secret-capture-create.js'
import {
  canManageSecretScope,
  hasEverySecretPermission,
  hasSecretPermission,
  secretGrantPrincipalExists,
} from './secret-route-access.js'
import type { RouteDeps } from './types.js'
const SecretScopeSchema = z.enum(['personal', 'team', 'project', 'organization'])

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
const vaultName = (reference: string): string => `NESSIE_${reference.slice(4).toUpperCase()}`

const sendVaultError = (reply: Parameters<typeof sendApiError>[0], error: unknown): boolean => {
  if (!(error instanceof InfisicalVaultError)) return false
  sendApiError(
    reply,
    error.code === 'NOT_CONFIGURED' ? 503 : 502,
    error.code === 'NOT_CONFIGURED' ? 'SECRETS_NOT_CONFIGURED' : 'VAULT_UNAVAILABLE',
    error.code === 'NOT_CONFIGURED'
      ? 'Secret storage is not configured.'
      : 'Secret storage is temporarily unavailable.',
  )
  return true
}
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
    const rawIdempotencyKey = request.headers['idempotency-key']
    if (rawIdempotencyKey !== undefined && typeof rawIdempotencyKey !== 'string') {
      return sendApiError(
        reply,
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be one value between 8 and 200 characters.',
      )
    }
    const idempotencyKey = rawIdempotencyKey?.trim() ?? ''
    if (rawIdempotencyKey !== undefined
      && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
      return sendApiError(
        reply,
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must contain between 8 and 200 characters.',
      )
    }
    const metadataFields = [body.name, body.description ?? '', body.provider ?? '']
    if (secretMetadataIsUnsafe(metadataFields, body.value)) {
      sendApiError(
        reply,
        422,
        'SECRET_METADATA_REJECTED',
        'Secret metadata cannot contain credential material.',
      )
      return reply
    }
    const scope = await canManageSecretScope({
      actorId: actorContext.actor.actorId,
      isOwner: actorContext.actor.roles?.includes('owner') ?? false,
      organizationId: actorContext.tenant.organizationId,
      prisma,
      scopeId: body.scopeId,
      scopeType: body.scopeType,
    })
    if (!scope.allowed) {
      sendApiError(reply, 403, 'SECRET_SCOPE_DENIED', 'You cannot manage secrets in this scope.')
      return reply
    }

    const reference = secretReferenceForCapture({
      actorId: actorContext.actor.actorId,
      idempotencyKey,
      organizationId: actorContext.tenant.organizationId,
    })
    let capture
    try {
      capture = await createSecretCapture({
        actorId: actorContext.actor.actorId,
        authSecret: deps.authSecret,
        body,
        idempotencyKey,
        organizationId: actorContext.tenant.organizationId,
        prisma,
        reference,
        scopeId: scope.scopeId,
      })
    } catch (error) {
      if (error instanceof SecretCaptureIdempotencyConflict) {
        return sendApiError(
          reply,
          409,
          'IDEMPOTENCY_CONFLICT',
          'That idempotency key was already used for a different secret capture.',
        )
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return sendApiError(
          reply,
          409,
          'SECRET_NAME_TAKEN',
          'A secret with this key already exists in that scope.',
        )
      }
      if (sendVaultError(reply, error)) return reply
      throw error
    }
    if (capture.mode === 'replayed') {
      return reply.code(200).send(createApiResponse(publicSecret(capture.secret)))
    }
    const secret = capture.secret
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
    if (secret.status !== 'active') {
      sendApiError(reply, 409, 'SECRET_NOT_ACTIVE', 'Only an active secret can be rotated.')
      return reply
    }
    const namespace: InfisicalSecretNamespace = {
      organizationId: secret.organizationId,
      scopeId: secret.scopeId,
      scopeType: secret.scopeType,
    }
    try {
      await new InfisicalVault().replace({
        name: vaultName(secret.reference),
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
    if (secret.status === 'revoked') return createApiResponse(publicSecret(secret))
    if (secret.status !== 'active') {
      sendApiError(reply, 409, 'SECRET_NOT_ACTIVE', 'Only an active secret can be revoked.')
      return reply
    }
    const namespace: InfisicalSecretNamespace = {
      organizationId: secret.organizationId,
      scopeId: secret.scopeId,
      scopeType: secret.scopeType,
    }
    try {
      await new InfisicalVault().remove({ name: vaultName(secret.reference), namespace })
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
      || await hasEverySecretPermission({
        actorId: actorContext.actor.actorId,
        permissions: body.permissions,
        prisma,
        secretId: secret.id,
      })
    if (!canDelegate) {
      sendApiError(reply, 403, 'SECRET_DELEGATE_DENIED', 'You cannot delegate access to this secret.')
      return reply
    }
    if (secret.status !== 'active') {
      sendApiError(reply, 409, 'SECRET_NOT_ACTIVE', 'Only an active secret can receive grants.')
      return reply
    }
    if (!(await secretGrantPrincipalExists({
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
      metadata: {
        permissions: grant.permissions,
        principalId: grant.principalId,
        principalType: grant.principalType,
        reference: secret.reference,
      },
    })
    return createApiResponse({ ...grant, expiresAt: grant.expiresAt?.toISOString() ?? null })
  })
}
