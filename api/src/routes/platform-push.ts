import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import {
  ApnsUploadFieldsSchema,
  PushTestRequestSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  createPushCredentialsService,
  PushCredentialError,
} from '../services/push-credentials.js'
import { createPushSecretStore } from '../services/push-secret-store.js'
import {
  deriveApnsKeyIdFromFilename,
  PushValidationError,
  PUSH_VALIDATION_ERROR_CODES,
  type FcmTokenExchange,
} from '../services/push-validation.js'

/**
 * Platform-scoped, super-admin-only push-credentials surface
 * (`/api/platform/push/*`). Backs Nessie's direct APNs/FCM delivery service.
 * Secret bytes are write-only — never returned by any handler.
 *
 * Plan: `docs/plans/2026-06-07-native-apps-and-push.md` → "Push credentials —
 * super-user upload".
 */

export type PlatformPushDeps = {
  prisma: PrismaClient
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireSuperAdmin: (
    actorContext: AuthorizedActionContext,
    reply: FastifyReply,
  ) => Promise<boolean>
  /** Encryption secret (auth secret) for the push SecretStore. */
  encryptionSecret: string
  /** Injectable Google token exchange for tests; defaults to live. */
  fcmTokenExchange?: FcmTokenExchange
}

const MAX_CRED_BYTES = 1024 * 1024 // 1 MB — push key/JSON files are tiny.

type MultipartUpload = {
  fileBuffer: Buffer | null
  filename: string | undefined
  fields: Record<string, string>
}

/**
 * Drain a multipart request into its single file plus text fields. Returns
 * null (after sending an error) when a file part exceeds the size cap.
 */
const readMultipart = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<MultipartUpload | null> => {
  let fileBuffer: Buffer | null = null
  let filename: string | undefined
  const fields: Record<string, string> = {}

  for await (const part of request.parts({ limits: { fileSize: MAX_CRED_BYTES } })) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer()
      if (part.file.truncated) {
        sendApiError(
          reply,
          413,
          'FILE_TOO_LARGE',
          `Credential file exceeds the ${MAX_CRED_BYTES} byte limit`,
        )
        return null
      }
      fileBuffer = buffer
      filename = part.filename
    } else {
      fields[part.fieldname] = String(part.value)
    }
  }

  return { fileBuffer, filename, fields }
}

const requireSuperAdminActor = async (
  request: FastifyRequest,
  reply: FastifyReply,
  deps: PlatformPushDeps,
): Promise<AuthorizedActionContext | null> => {
  const actorContext = deps.requireActorContext(request, reply)
  if (!actorContext) {
    return null
  }
  if (!(await deps.requireSuperAdmin(actorContext, reply))) {
    return null
  }
  return actorContext
}

export const registerPlatformPushRoutes = (
  app: FastifyInstance,
  deps: PlatformPushDeps,
): void => {
  const { prisma } = deps
  const secretStore = createPushSecretStore(prisma, deps.encryptionSecret)
  const service = createPushCredentialsService({
    prisma,
    secretStore,
    fcmTokenExchange: deps.fcmTokenExchange,
  })

  app.put('/api/platform/push/apns', async (request, reply) => {
    const actorContext = await requireSuperAdminActor(request, reply, deps)
    if (!actorContext) return reply

    const upload = await readMultipart(request, reply)
    if (!upload) return reply
    if (!upload.fileBuffer) {
      sendApiError(reply, 400, 'NO_FILE', 'Missing the .p8 key file part')
      return reply
    }

    const fields = parseInput(ApnsUploadFieldsSchema, upload.fields, reply)
    if (!fields) return reply

    const keyId = fields.keyId ?? deriveApnsKeyIdFromFilename(upload.filename)
    if (!keyId) {
      sendApiError(
        reply,
        400,
        PUSH_VALIDATION_ERROR_CODES.APNS_KEY_ID_MISSING,
        'Key ID not supplied and could not be derived from the filename '
          + '(expected AuthKey_<KEYID>.p8).',
      )
      return reply
    }

    try {
      const result = await service.upsertApns({
        p8: upload.fileBuffer.toString('utf8'),
        keyId,
        fields,
        userId: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'push.credential.uploaded',
        resourceType: 'push_credential',
        resourceId: 'apns',
        outcome: 'success',
        metadata: {
          provider: 'apns',
          keyId: result.keyId,
          teamId: fields.teamId,
          topic: fields.topic,
          environment: fields.environment ?? 'production',
        },
      })
      return createApiResponse({
        provider: 'apns' as const,
        ok: true,
        message: 'APNs credential stored.',
      })
    } catch (error) {
      return handlePushError(reply, error)
    }
  })

  app.put('/api/platform/push/fcm', async (request, reply) => {
    const actorContext = await requireSuperAdminActor(request, reply, deps)
    if (!actorContext) return reply

    const upload = await readMultipart(request, reply)
    if (!upload) return reply
    if (!upload.fileBuffer) {
      sendApiError(reply, 400, 'NO_FILE', 'Missing the service-account JSON file part')
      return reply
    }

    try {
      const result = await service.upsertFcm({
        json: upload.fileBuffer.toString('utf8'),
        userId: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'push.credential.uploaded',
        resourceType: 'push_credential',
        resourceId: 'fcm',
        outcome: 'success',
        metadata: {
          provider: 'fcm',
          projectId: result.projectId,
          clientEmail: result.clientEmail,
        },
      })
      return createApiResponse({
        provider: 'fcm' as const,
        ok: true,
        message: 'FCM credential stored.',
      })
    } catch (error) {
      return handlePushError(reply, error)
    }
  })

  app.get('/api/platform/push/status', async (request, reply) => {
    const actorContext = await requireSuperAdminActor(request, reply, deps)
    if (!actorContext) return reply
    return createApiResponse(await service.getStatus())
  })

  app.post('/api/platform/push/test', async (request, reply) => {
    const actorContext = await requireSuperAdminActor(request, reply, deps)
    if (!actorContext) return reply

    const body = parseInput(PushTestRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    const device = body.provider === 'apns'
      ? await prisma.deviceToken.findFirst({
          where: {
            organizationId: actorContext.tenant.organizationId,
            userId: actorContext.actor.actorId,
            platform: 'ios',
            inactiveAt: null,
          },
          orderBy: { lastSeenAt: 'desc' },
        })
      : null
    const result = await service.test({
      provider: body.provider,
      deviceToken: device?.token,
      apnsEnvironment: device?.apnsEnvironment ?? undefined,
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'push.credential.tested',
      resourceType: 'push_credential',
      resourceId: body.provider,
      outcome: result.ok ? 'success' : 'error',
      reason: result.ok ? undefined : result.message,
      metadata: { provider: body.provider, delivered: result.delivered ?? false },
    })
    return createApiResponse({ provider: body.provider, ...result })
  })

  const deleteHandler = (provider: 'apns' | 'fcm') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actorContext = await requireSuperAdminActor(request, reply, deps)
      if (!actorContext) return reply

      const removed = await service.remove(provider)
      if (!removed) {
        sendApiError(
          reply,
          404,
          'PUSH_CREDENTIAL_NOT_FOUND',
          `No ${provider} credential configured`,
        )
        return reply
      }
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'push.credential.deleted',
        resourceType: 'push_credential',
        resourceId: provider,
        outcome: 'success',
        metadata: { provider },
      })
      return createApiResponse({
        provider,
        ok: true,
        message: `${provider} credential deleted.`,
      })
    }

  app.delete('/api/platform/push/apns', deleteHandler('apns'))
  app.delete('/api/platform/push/fcm', deleteHandler('fcm'))
}

const handlePushError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof PushValidationError) {
    sendApiError(reply, 400, error.code, error.message)
    return reply
  }
  if (error instanceof PushCredentialError) {
    // The service account failed Google's live exchange — an upstream rejection.
    sendApiError(reply, 502, error.code, error.message)
    return reply
  }
  throw error
}
