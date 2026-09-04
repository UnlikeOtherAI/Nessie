import crypto from 'node:crypto'
import { detectSecrets } from '@nessie/schemas'

export type SecretCaptureMetadata = {
  description?: string
  expiresAt?: string
  name: string
  provider?: string
  scopeType: string
  value: string
}

type StoredSecretCapture = {
  captureFingerprint: string | null
  createdById: string
  description: string | null
  expiresAt: Date | null
  name: string
  organizationId: string
  provider: string | null
  scopeId: string
  scopeType: string
  status: string
}

export const secretReferenceForCapture = (input: {
  actorId: string
  idempotencyKey: string
  organizationId: string
}): string => input.idempotencyKey
  ? `sec_${crypto.createHash('sha256').update([
    'capture-v1',
    input.organizationId,
    input.actorId,
    input.idempotencyKey,
  ].join('\0')).digest('hex').slice(0, 32)}`
  : `sec_${crypto.randomBytes(16).toString('hex')}`

export const secretMatchesCaptureRequest = (
  secret: StoredSecretCapture,
  body: SecretCaptureMetadata,
  input: { actorId: string; authSecret: string; organizationId: string; scopeId: string },
): boolean => secret.createdById === input.actorId
  && secret.status === 'active'
  && secret.organizationId === input.organizationId
  && secret.name === body.name
  && secret.description === (body.description ?? null)
  && secret.provider === (body.provider ?? null)
  && secret.scopeType === body.scopeType
  && secret.scopeId === input.scopeId
  && (secret.expiresAt?.toISOString() ?? null)
    === (body.expiresAt ? new Date(body.expiresAt).toISOString() : null)
  && secret.captureFingerprint === captureFingerprintForValue(
    input.authSecret,
    input.organizationId,
    body.value,
  )

const CAPTURE_FINGERPRINT_DOMAIN = 'nessie.secret-capture.value.v1\0'

export const captureFingerprintForValue = (
  authSecret: string,
  organizationId: string,
  value: string,
): string =>
  crypto.createHmac('sha256', authSecret)
    .update(CAPTURE_FINGERPRINT_DOMAIN)
    .update(organizationId)
    .update('\0')
    .update(value)
    .digest('base64url')

export const secretMetadataIsUnsafe = (
  fields: string[],
  secretValue: string,
): boolean => {
  const comparableValue = secretValue.trim()
  return fields.some((field) => {
    const duplicatesValue = comparableValue.length > 3
      ? field.includes(comparableValue)
      : field.trim() === comparableValue
    return duplicatesValue || detectSecrets(field).length > 0
  })
}
