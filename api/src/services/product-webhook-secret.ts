import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  DEEPSIGNAL_MCP_CREDENTIAL_REF,
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
  verifyHmacSignature,
} from '@nessie/runtime'

/**
 * Per-organization inbound-webhook signing secret store (DeepSignal §6).
 *
 * A product (DeepSignal) returns a signing secret exactly once when a webhook is
 * registered on its side; a Nessie org admin pastes it here. It is stored
 * encrypted at rest (AES-256-GCM under a key derived from the deployment auth
 * secret) and only ever read to verify an inbound HMAC. `resolveSignedWebhookOrg`
 * identifies which org a signed request belongs to by finding the stored secret
 * that reproduces the request signature — so a single unauthenticated receiver
 * URL serves every org without leaking which org a request targeted.
 */

export class ProductWebhookSecretError extends Error {
  readonly code = 'PRODUCT_WEBHOOK_SECRET_REUSES_APP_CREDENTIAL'

  constructor() {
    super('A webhook signing secret must be distinct from every application credential.')
    this.name = 'ProductWebhookSecretError'
  }
}

const sameSecret = (left: string, right: string): boolean => {
  const leftDigest = crypto.createHash('sha256').update(left).digest()
  const rightDigest = crypto.createHash('sha256').update(right).digest()
  return crypto.timingSafeEqual(leftDigest, rightDigest)
}

const assertWebhookSecretIsIndependent = (
  input: { productSlug: string; secret: string },
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (input.productSlug !== 'deepsignal') return
  const reservedNames = [
    DEEPSIGNAL_MCP_CREDENTIAL_REF,
    'LEDGER_PROXY_TOKEN',
    'NESSIE_MODEL_API_KEY',
    'UOA_CLIENT_SECRET',
    'NESSIE_AUTH_SECRET',
  ]
  const reused = reservedNames.some((name) => {
    const value = env[name]?.trim()
    return Boolean(value && sameSecret(value, input.secret))
  })
  if (reused) throw new ProductWebhookSecretError()
}

export const setProductWebhookSecret = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  input: { organizationId: string; productSlug: string; secret: string },
): Promise<void> => {
  assertWebhookSecretIsIndependent(input)
  const key = deriveSecretKey(encryptionSecret)
  const { ciphertext, iv, authTag } = encryptWithKey(key, input.secret)
  await prisma.productWebhookSecret.upsert({
    where: {
      organizationId_productSlug: {
        organizationId: input.organizationId,
        productSlug: input.productSlug,
      },
    },
    create: {
      organizationId: input.organizationId,
      productSlug: input.productSlug,
      ciphertext,
      iv,
      authTag,
    },
    update: { ciphertext, iv, authTag },
  })
}

/**
 * Resolve which organization a signed webhook request belongs to by finding the
 * stored secret for `productSlug` whose HMAC-SHA256 over the raw body reproduces
 * the supplied signature. Constant work per candidate row + timing-safe compare.
 * Returns the organization id, or null when no stored secret matches (reject).
 */
export const resolveSignedWebhookOrg = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  input: { productSlug: string; rawBody: Buffer; signatureHeader: string | undefined },
): Promise<string | null> => {
  if (!input.signatureHeader || input.signatureHeader.trim().length === 0) {
    return null
  }

  const rows = await prisma.productWebhookSecret.findMany({
    where: { productSlug: input.productSlug },
    select: { organizationId: true, ciphertext: true, iv: true, authTag: true },
  })
  const key = deriveSecretKey(encryptionSecret)

  let matchedOrg: string | null = null
  for (const row of rows) {
    let secret: string
    try {
      secret = decryptWithKey(key, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      })
    } catch {
      continue
    }
    const matches = verifyHmacSignature({
      encoding: 'hex',
      payload: input.rawBody,
      prefix: 'sha256=',
      secret,
      signature: input.signatureHeader,
    })
    if (matches && matchedOrg === null) {
      matchedOrg = row.organizationId
    }
  }
  return matchedOrg
}
