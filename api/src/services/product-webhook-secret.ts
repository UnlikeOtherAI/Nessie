import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { decryptWithKey, deriveSecretKey, encryptWithKey } from '@nessie/runtime'

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

export const setProductWebhookSecret = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  input: { organizationId: string; productSlug: string; secret: string },
): Promise<void> => {
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

/** Strip a GitHub-style `sha256=` prefix from a signature header value. */
const stripSignaturePrefix = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.toLowerCase().startsWith('sha256=')
    ? trimmed.slice('sha256='.length)
    : trimmed
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
  let provided: Buffer
  try {
    provided = Buffer.from(stripSignaturePrefix(input.signatureHeader), 'hex')
  } catch {
    return null
  }
  if (provided.length === 0) return null

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
    const expected = crypto.createHmac('sha256', secret).update(input.rawBody).digest()
    if (
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided) &&
      matchedOrg === null
    ) {
      matchedOrg = row.organizationId
    }
  }
  return matchedOrg
}
