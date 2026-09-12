import type { PrismaClient } from '@prisma/client'
import {
  AT_REST_SECRET_PURPOSE,
  decryptWithKeyRing,
  encryptWithKeyRing,
  openSecret,
  sealSecret,
  toEncryptionKeyRing,
  type EncryptionKeyRingInput,
} from '@nessie/runtime'

/**
 * The durable ciphertext inventory for encryption-root rotation.
 *
 * This procedure is deliberately an API service rather than a SQL rewrite:
 * only the crypto boundary can authenticate a ciphertext's purpose before it
 * is replaced. Every write compares the ciphertext read from Postgres, so a
 * concurrent credential refresh or normal write wins without being reverted.
 */
export type AtRestSecretRotationResult = Record<string, {
  conflicts: number
  rotated: number
}>

export class AtRestSecretRotationError extends Error {
  constructor(store: string, cause: unknown) {
    super(`[at-rest-secret-rotation] ${store} could not be authenticated and re-encrypted.`)
    this.name = 'AtRestSecretRotationError'
    this.cause = cause
  }
}

type RotationCounts = { conflicts: number; rotated: number }
type Page<T> = { id: string; row: T }

const packedReplacement = (
  encryption: EncryptionKeyRingInput,
  purpose: string,
  packed: string,
): string => sealSecret(encryption, openSecret(encryption, packed, purpose), purpose)

const envelopeReplacement = (
  encryption: EncryptionKeyRingInput,
  purpose: string,
  parts: { authTag: string; ciphertext: string; iv: string },
) => {
  const keyRing = toEncryptionKeyRing(encryption)
  const opened = decryptWithKeyRing(keyRing, purpose, parts)
  return encryptWithKeyRing(keyRing, purpose, opened.plaintext)
}

const commandReplacement = (
  encryption: EncryptionKeyRingInput,
  ciphertext: string,
): string => {
  let parsed: { authTag: string; ciphertext: string; iv: string }
  try {
    parsed = JSON.parse(ciphertext) as typeof parsed
  } catch (error) {
    throw new Error('executor command ciphertext is not JSON', { cause: error })
  }
  return JSON.stringify(envelopeReplacement(
    encryption,
    AT_REST_SECRET_PURPOSE.executorCommand,
    parsed,
  ))
}

const mcpSecretPurpose = (ref: string): string => {
  if (ref.startsWith('secret_oauth_')) return AT_REST_SECRET_PURPOSE.mcpOauth
  if (ref.startsWith('secret_mcp_')) return AT_REST_SECRET_PURPOSE.mcpCredential
  if (ref.startsWith('secret_push_')) return AT_REST_SECRET_PURPOSE.pushCredential
  if (ref.startsWith('secret_browserbase_')) return AT_REST_SECRET_PURPOSE.browserConnection
  if (ref.startsWith('secret_dashboard_')) return AT_REST_SECRET_PURPOSE.dashboardCredential
  throw new Error(`unrecognised durable secret reference '${ref.slice(0, 32)}'`)
}

const rotatePages = async <T>(
  store: string,
  load: (after: string | null) => Promise<Array<Page<T>>>,
  rotate: (row: T) => Promise<boolean>,
  counts: RotationCounts,
): Promise<void> => {
  let after: string | null = null
  while (true) {
    const page = await load(after)
    if (page.length === 0) return
    for (const item of page) {
      try {
        if (await rotate(item.row)) counts.rotated += 1
        else counts.conflicts += 1
      } catch (error) {
        throw new AtRestSecretRotationError(store, error)
      }
    }
    after = page.at(-1)?.id ?? null
  }
}

const countsFor = (
  result: AtRestSecretRotationResult,
  store: string,
): RotationCounts => (result[store] = { conflicts: 0, rotated: 0 })

/**
 * Authenticate and rewrite every durable at-rest ciphertext under the active
 * ring version. It is safe to run from a one-off maintenance process while API
 * and worker replicas keep serving: the conditional writes never overwrite a
 * concurrent rotation, and any corrupt/missing-key row aborts the procedure
 * before an operator can retire a root.
 */
export const rotateDurableAtRestSecrets = async (
  prisma: PrismaClient,
  encryption: EncryptionKeyRingInput,
  options: { batchSize?: number } = {},
): Promise<AtRestSecretRotationResult> => {
  const batchSize = options.batchSize ?? 100
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('[at-rest-secret-rotation] batchSize must be an integer from 1 to 1000.')
  }
  const keyRing = toEncryptionKeyRing(encryption)
  const result: AtRestSecretRotationResult = {}

  await rotatePages(
    'uoa_session_credentials',
    async (after) => (await prisma.uoaSessionCredential.findMany({
      ...(after ? { where: { familyId: { gt: after } } } : {}),
      orderBy: { familyId: 'asc' },
      select: {
        familyId: true, refreshTokenAuthTag: true, refreshTokenCiphertext: true, refreshTokenIv: true,
      },
      take: batchSize,
    })).map((row) => ({ id: row.familyId, row })),
    async (row) => {
      const replacement = envelopeReplacement(encryption, AT_REST_SECRET_PURPOSE.uoaRefresh, {
        authTag: row.refreshTokenAuthTag, ciphertext: row.refreshTokenCiphertext, iv: row.refreshTokenIv,
      })
      const update = await prisma.uoaSessionCredential.updateMany({
        where: {
          familyId: row.familyId,
          refreshTokenAuthTag: row.refreshTokenAuthTag,
          refreshTokenCiphertext: row.refreshTokenCiphertext,
          refreshTokenIv: row.refreshTokenIv,
        },
        data: {
          refreshTokenAuthTag: replacement.authTag,
          refreshTokenCiphertext: replacement.ciphertext,
          refreshTokenIv: replacement.iv,
        },
      })
      return update.count === 1
    },
    countsFor(result, 'uoa_session_credentials'),
  )

  await rotatePages(
    'mcp_oauth_secret',
    async (after) => (await prisma.mcpOAuthSecret.findMany({
      ...(after ? { where: { ref: { gt: after } } } : {}),
      orderBy: { ref: 'asc' },
      select: { authTag: true, ciphertext: true, iv: true, ref: true },
      take: batchSize,
    })).map((row) => ({ id: row.ref, row })),
    async (row) => {
      const replacement = envelopeReplacement(encryption, mcpSecretPurpose(row.ref), row)
      const update = await prisma.mcpOAuthSecret.updateMany({
        where: { ref: row.ref, ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
        data: replacement,
      })
      return update.count === 1
    },
    countsFor(result, 'mcp_oauth_secret'),
  )

  await rotatePages(
    'product_webhook_secrets',
    async (after) => (await prisma.productWebhookSecret.findMany({
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: 'asc' },
      select: { authTag: true, ciphertext: true, id: true, iv: true },
      take: batchSize,
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const replacement = envelopeReplacement(encryption, AT_REST_SECRET_PURPOSE.productWebhook, row)
      const update = await prisma.productWebhookSecret.updateMany({
        where: { id: row.id, ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
        data: replacement,
      })
      return update.count === 1
    },
    countsFor(result, 'product_webhook_secrets'),
  )

  await rotatePages(
    'board_source_connection_credentials',
    async (after) => (await prisma.boardSourceConnectionCredential.findMany({
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: 'asc' },
      select: { accessTokenCiphertext: true, id: true, refreshTokenCiphertext: true },
      take: batchSize,
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const accessTokenCiphertext = packedReplacement(
        encryption, AT_REST_SECRET_PURPOSE.boardSourceCredential, row.accessTokenCiphertext,
      )
      const refreshTokenCiphertext = row.refreshTokenCiphertext
        ? packedReplacement(encryption, AT_REST_SECRET_PURPOSE.boardSourceCredential, row.refreshTokenCiphertext)
        : null
      const update = await prisma.boardSourceConnectionCredential.updateMany({
        where: {
          id: row.id,
          accessTokenCiphertext: row.accessTokenCiphertext,
          refreshTokenCiphertext: row.refreshTokenCiphertext,
        },
        data: { accessTokenCiphertext, refreshTokenCiphertext, keyVersion: keyRing.activeVersion },
      })
      return update.count === 1
    },
    countsFor(result, 'board_source_connection_credentials'),
  )

  await rotatePages(
    'board_source_webhook_secrets',
    async (after) => (await prisma.boardSource.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, webhookSecretCiphertext: true },
      take: batchSize,
      where: {
        ...(after ? { id: { gt: after } } : {}),
        webhookSecretCiphertext: { not: null },
      },
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const current = row.webhookSecretCiphertext
      if (!current) return true
      const webhookSecretCiphertext = packedReplacement(
        encryption, AT_REST_SECRET_PURPOSE.boardSourceWebhook, current,
      )
      const update = await prisma.boardSource.updateMany({
        where: { id: row.id, webhookSecretCiphertext: current },
        data: { webhookSecretCiphertext },
      })
      return update.count === 1
    },
    countsFor(result, 'board_source_webhook_secrets'),
  )

  await rotatePages(
    'comms_connection_credentials',
    async (after) => (await prisma.commsConnectionCredential.findMany({
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: 'asc' },
      select: { accessTokenCiphertext: true, id: true, refreshTokenCiphertext: true },
      take: batchSize,
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const accessTokenCiphertext = packedReplacement(
        encryption, AT_REST_SECRET_PURPOSE.commsCredential, row.accessTokenCiphertext,
      )
      const refreshTokenCiphertext = row.refreshTokenCiphertext
        ? packedReplacement(encryption, AT_REST_SECRET_PURPOSE.commsCredential, row.refreshTokenCiphertext)
        : null
      const update = await prisma.commsConnectionCredential.updateMany({
        where: {
          id: row.id,
          accessTokenCiphertext: row.accessTokenCiphertext,
          refreshTokenCiphertext: row.refreshTokenCiphertext,
        },
        data: { accessTokenCiphertext, refreshTokenCiphertext, keyVersion: keyRing.activeVersion },
      })
      return update.count === 1
    },
    countsFor(result, 'comms_connection_credentials'),
  )

  await rotatePages(
    'mailbox_connection_credentials',
    async (after) => (await prisma.mailboxConnectionCredential.findMany({
      ...(after ? { where: { id: { gt: after } } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, secretCiphertext: true },
      take: batchSize,
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const secretCiphertext = packedReplacement(
        encryption, AT_REST_SECRET_PURPOSE.mailboxCredential, row.secretCiphertext,
      )
      const update = await prisma.mailboxConnectionCredential.updateMany({
        where: { id: row.id, secretCiphertext: row.secretCiphertext },
        data: { keyVersion: keyRing.activeVersion, secretCiphertext },
      })
      return update.count === 1
    },
    countsFor(result, 'mailbox_connection_credentials'),
  )

  await rotatePages(
    'cloud_browser_sessions',
    async (after) => (await prisma.cloudBrowserSession.findMany({
      orderBy: { id: 'asc' },
      select: { connectCapabilityCiphertext: true, id: true },
      take: batchSize,
      where: {
        ...(after ? { id: { gt: after } } : {}),
        connectCapabilityCiphertext: { not: null },
      },
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const current = row.connectCapabilityCiphertext
      if (!current) return true
      const connectCapabilityCiphertext = packedReplacement(
        encryption, AT_REST_SECRET_PURPOSE.browserSessionCapability, current,
      )
      const update = await prisma.cloudBrowserSession.updateMany({
        where: { id: row.id, connectCapabilityCiphertext: current },
        data: { connectCapabilityCiphertext },
      })
      return update.count === 1
    },
    countsFor(result, 'cloud_browser_sessions'),
  )

  await rotatePages(
    'executor_commands',
    async (after) => (await prisma.executorCommand.findMany({
      orderBy: { id: 'asc' },
      select: { deliveryPayloadCiphertext: true, id: true, resultCiphertext: true },
      take: batchSize,
      where: {
        ...(after ? { id: { gt: after } } : {}),
        OR: [
          { deliveryPayloadCiphertext: { not: null } },
          { resultCiphertext: { not: null } },
        ],
      },
    })).map((row) => ({ id: row.id, row })),
    async (row) => {
      const deliveryPayloadCiphertext = row.deliveryPayloadCiphertext
        ? commandReplacement(encryption, row.deliveryPayloadCiphertext)
        : null
      const resultCiphertext = row.resultCiphertext
        ? commandReplacement(encryption, row.resultCiphertext)
        : null
      const update = await prisma.executorCommand.updateMany({
        where: {
          id: row.id,
          deliveryPayloadCiphertext: row.deliveryPayloadCiphertext,
          resultCiphertext: row.resultCiphertext,
        },
        data: { deliveryPayloadCiphertext, resultCiphertext },
      })
      return update.count === 1
    },
    countsFor(result, 'executor_commands'),
  )

  return result
}
