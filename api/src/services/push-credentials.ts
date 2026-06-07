import type { PrismaClient } from '@prisma/client'
import type {
  ApnsUploadFields,
  PushApnsEnvironment,
  PushStatusResponse,
} from '@nessie/schemas'

import type { PushSecretStore } from './push-secret-store.js'
import {
  liveFcmTokenExchange,
  mintApnsJwt,
  parseFcmServiceAccount,
  type FcmTokenExchange,
} from './push-validation.js'

export const PUSH_CREDENTIAL_ERROR_CODES = {
  FCM_EXCHANGE_FAILED: 'FCM_EXCHANGE_FAILED',
} as const
export type PushCredentialErrorCode =
  (typeof PUSH_CREDENTIAL_ERROR_CODES)[keyof typeof PUSH_CREDENTIAL_ERROR_CODES]

export class PushCredentialError extends Error {
  constructor(
    public readonly code: PushCredentialErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PushCredentialError'
  }
}

/**
 * Push-credentials service: orchestrates validation, encrypted secret storage,
 * and the non-secret metadata row for each provider (apns | fcm).
 *
 * Secret bytes (.p8 / FCM JSON) are stored ONLY via the {@link PushSecretStore}
 * and are never persisted on, nor returned through, the metadata row.
 */
export type PushCredentialsService = ReturnType<typeof createPushCredentialsService>

export const createPushCredentialsService = (deps: {
  prisma: PrismaClient
  secretStore: PushSecretStore
  /** Injectable for tests; defaults to the live Google exchange. */
  fcmTokenExchange?: FcmTokenExchange
}) => {
  const { prisma, secretStore } = deps
  const fcmExchange = deps.fcmTokenExchange ?? liveFcmTokenExchange

  /**
   * Validate + store (or replace) the APNs `.p8` credential. Minting the ES256
   * JWT proves the key signs; only then is the secret persisted and the
   * metadata row upserted. Returns the resolved Key ID.
   */
  const upsertApns = async (input: {
    p8: string
    keyId: string
    fields: ApnsUploadFields
    userId: string
  }): Promise<{ keyId: string }> => {
    const environment: PushApnsEnvironment = input.fields.environment ?? 'production'
    // Throws PushValidationError if the key is unusable — caller maps to 400.
    mintApnsJwt({ p8: input.p8, keyId: input.keyId, teamId: input.fields.teamId })

    const secretRef = await secretStore.put(input.p8)
    const previous = await prisma.pushCredential.findUnique({
      where: { provider: 'apns' },
    })

    await prisma.pushCredential.upsert({
      where: { provider: 'apns' },
      create: {
        provider: 'apns',
        secretRef,
        apnsKeyId: input.keyId,
        apnsTeamId: input.fields.teamId,
        apnsTopic: input.fields.topic,
        apnsEnvironment: environment,
        updatedByUserId: input.userId,
      },
      update: {
        secretRef,
        apnsKeyId: input.keyId,
        apnsTeamId: input.fields.teamId,
        apnsTopic: input.fields.topic,
        apnsEnvironment: environment,
        updatedByUserId: input.userId,
      },
    })

    // Best-effort cleanup of the superseded secret (post-commit so a failure
    // never leaves the metadata row pointing at a deleted secret).
    if (previous && previous.secretRef !== secretRef) {
      await secretStore.remove(previous.secretRef)
    }

    return { keyId: input.keyId }
  }

  /**
   * Validate + store (or replace) the FCM service-account JSON. Asserts the
   * JSON shape and runs the live token exchange before persisting.
   */
  const upsertFcm = async (input: {
    json: string
    userId: string
  }): Promise<{ projectId: string; clientEmail: string }> => {
    const account = parseFcmServiceAccount(input.json)
    const exchange = await fcmExchange(account)
    if (!exchange.ok) {
      throw new PushCredentialError('FCM_EXCHANGE_FAILED', exchange.message)
    }

    const secretRef = await secretStore.put(input.json)
    const previous = await prisma.pushCredential.findUnique({
      where: { provider: 'fcm' },
    })

    await prisma.pushCredential.upsert({
      where: { provider: 'fcm' },
      create: {
        provider: 'fcm',
        secretRef,
        fcmProjectId: account.project_id,
        fcmClientEmail: account.client_email,
        updatedByUserId: input.userId,
      },
      update: {
        secretRef,
        fcmProjectId: account.project_id,
        fcmClientEmail: account.client_email,
        updatedByUserId: input.userId,
      },
    })

    if (previous && previous.secretRef !== secretRef) {
      await secretStore.remove(previous.secretRef)
    }

    return { projectId: account.project_id, clientEmail: account.client_email }
  }

  /** Metadata-only status for both providers. Never reads secret bytes. */
  const getStatus = async (): Promise<PushStatusResponse> => {
    const rows = await prisma.pushCredential.findMany()
    const apns = rows.find((r) => r.provider === 'apns')
    const fcm = rows.find((r) => r.provider === 'fcm')

    return {
      apns: apns
        ? {
            configured: true,
            keyId: apns.apnsKeyId ?? '',
            teamId: apns.apnsTeamId ?? '',
            topic: apns.apnsTopic ?? '',
            environment: (apns.apnsEnvironment ?? 'production') as PushApnsEnvironment,
            updatedAt: apns.updatedAt.toISOString(),
            updatedByUserId: apns.updatedByUserId,
          }
        : { configured: false },
      fcm: fcm
        ? {
            configured: true,
            projectId: fcm.fcmProjectId ?? '',
            clientEmail: fcm.fcmClientEmail ?? '',
            updatedAt: fcm.updatedAt.toISOString(),
            updatedByUserId: fcm.updatedByUserId,
          }
        : { configured: false },
    }
  }

  const remove = async (provider: 'apns' | 'fcm'): Promise<boolean> => {
    const row = await prisma.pushCredential.findUnique({ where: { provider } })
    if (!row) {
      return false
    }
    await prisma.pushCredential.delete({ where: { provider } })
    await secretStore.remove(row.secretRef)
    return true
  }

  /**
   * Re-validate the stored credential end-to-end. Re-mints the APNs JWT /
   * re-runs the FCM exchange from the stored secret. A real send is out of
   * scope for the per-instance API (the gateway owns the wire); a supplied
   * device token is acknowledged but delivery is reported as not attempted.
   */
  const test = async (input: {
    provider: 'apns' | 'fcm'
    deviceToken?: string
  }): Promise<{ ok: boolean; message: string; delivered?: boolean }> => {
    const row = await prisma.pushCredential.findUnique({
      where: { provider: input.provider },
    })
    if (!row) {
      return { ok: false, message: `No ${input.provider} credential configured.` }
    }

    const secret = await secretStore.resolve(row.secretRef)
    if (!secret) {
      return {
        ok: false,
        message: `Stored ${input.provider} secret could not be resolved.`,
      }
    }

    if (input.provider === 'apns') {
      try {
        mintApnsJwt({
          p8: secret,
          keyId: row.apnsKeyId ?? '',
          teamId: row.apnsTeamId ?? '',
        })
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'APNs validation failed.',
        }
      }
      return {
        ok: true,
        message: input.deviceToken
          ? 'APNs credential valid. Real send is performed by the push gateway, not the API.'
          : 'APNs credential valid (ES256 JWT minted).',
        delivered: false,
      }
    }

    const account = parseFcmServiceAccount(secret)
    const exchange = await fcmExchange(account)
    return {
      ok: exchange.ok,
      message: exchange.ok && input.deviceToken
        ? 'FCM credential valid. Real send is performed by the push gateway, not the API.'
        : exchange.message,
      delivered: false,
    }
  }

  return { upsertApns, upsertFcm, getStatus, remove, test }
}
