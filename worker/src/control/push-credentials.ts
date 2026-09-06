import type { PrismaClient } from '@prisma/client'
import { decryptWithKey, deriveSecretKey } from '@nessie/runtime'
import type { ApnsCredentials, FcmCredentials } from '@nessie/push'

/**
 * Loading and decrypting the deployment's stored APNs/FCM credentials — the
 * half of push delivery that talks to the secret store rather than to a
 * provider. It lives beside `push-delivery-core.ts` (which re-exports
 * {@link loadPushCredentials} so every existing import path still works) because
 * the two concerns are independent: the core decides who is sent to and records
 * the outcome, this file only turns two `push_credentials` rows plus their
 * encrypted secrets into usable credentials.
 */

/** Minimal Prisma surface credential loading touches — keeps tests light. */
export type PushCredentialPrisma = Pick<
  PrismaClient,
  'pushCredential' | 'mcpOAuthSecret'
>

export type LoadedPushCredentials = {
  apnsCreds: ApnsCredentials | null
  fcmCreds: FcmCredentials | null
}

const decryptSecret = async (
  prisma: Pick<PushCredentialPrisma, 'mcpOAuthSecret'>,
  authSecret: string,
  secretRef: string,
): Promise<string | null> => {
  const row = await prisma.mcpOAuthSecret.findUnique({ where: { ref: secretRef } })
  if (!row) {
    return null
  }
  return decryptWithKey(deriveSecretKey(authSecret), {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
  })
}

/**
 * Build the decrypted APNs credentials from the `push_credentials` row + the
 * `.p8` plaintext, or null if the row is incomplete / the secret is missing.
 */
const loadApnsCreds = async (
  prisma: Pick<PushCredentialPrisma, 'mcpOAuthSecret'>,
  authSecret: string,
  row: {
    secretRef: string
    apnsKeyId: string | null
    apnsTeamId: string | null
    apnsTopic: string | null
    apnsEnvironment: 'sandbox' | 'production' | null
  },
): Promise<ApnsCredentials | null> => {
  if (!row.apnsKeyId || !row.apnsTeamId || !row.apnsTopic) {
    return null
  }
  const p8 = await decryptSecret(prisma, authSecret, row.secretRef)
  if (!p8) {
    return null
  }
  return {
    p8,
    keyId: row.apnsKeyId,
    teamId: row.apnsTeamId,
    topic: row.apnsTopic,
    environment: row.apnsEnvironment ?? 'production',
  }
}

const loadFcmCreds = async (
  prisma: Pick<PushCredentialPrisma, 'mcpOAuthSecret'>,
  authSecret: string,
  row: { secretRef: string },
): Promise<FcmCredentials | null> => {
  const serviceAccountJson = await decryptSecret(prisma, authSecret, row.secretRef)
  if (!serviceAccountJson) {
    return null
  }
  return { serviceAccountJson }
}

/**
 * Load and decrypt the deployment's APNs + FCM credentials from the
 * `push_credentials` table. Returns nulls for absent/incomplete providers.
 */
export const loadPushCredentials = async (
  deps: { prisma: PushCredentialPrisma; authSecret: string },
): Promise<LoadedPushCredentials> => {
  const credRows = await deps.prisma.pushCredential.findMany()
  const apnsRow = credRows.find((r) => r.provider === 'apns') ?? null
  const fcmRow = credRows.find((r) => r.provider === 'fcm') ?? null
  return {
    apnsCreds: apnsRow ? await loadApnsCreds(deps.prisma, deps.authSecret, apnsRow) : null,
    fcmCreds: fcmRow ? await loadFcmCreds(deps.prisma, deps.authSecret, fcmRow) : null,
  }
}
