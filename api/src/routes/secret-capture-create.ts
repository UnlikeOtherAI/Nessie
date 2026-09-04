import type { Prisma, PrismaClient, Secret } from '@prisma/client'

import {
  InfisicalVault,
  type InfisicalSecretNamespace,
} from '../services/infisical-vault.js'
import {
  captureFingerprintForValue,
  secretMatchesCaptureRequest,
  type SecretCaptureMetadata,
} from './secret-capture-idempotency.js'

type SecretCaptureBody = SecretCaptureMetadata & {
  scopeType: InfisicalSecretNamespace['scopeType']
}

export class SecretCaptureIdempotencyConflict extends Error {}

type CaptureResult = {
  mode: 'created' | 'replayed'
  secret: Secret
}

const vaultName = (reference: string): string => `NESSIE_${reference.slice(4).toUpperCase()}`

/**
 * Serialize one client capture across API instances before touching Infisical.
 * The transaction deliberately spans the vault call: without the advisory
 * lock, two requests can race the same deterministic vault name before the
 * unique metadata row identifies the winner.
 */
export const createSecretCapture = async (input: {
  actorId: string
  authSecret: string
  body: SecretCaptureBody
  idempotencyKey: string
  organizationId: string
  prisma: PrismaClient
  reference: string
  scopeId: string
}): Promise<CaptureResult> => {
  const namespace: InfisicalSecretNamespace = {
    organizationId: input.organizationId,
    scopeId: input.scopeId,
    scopeType: input.body.scopeType,
  }
  const written = { vault: null as InfisicalVault | null }

  const create = async (client: Prisma.TransactionClient | PrismaClient): Promise<Secret> => {
    const vault = new InfisicalVault()
    const name = vaultName(input.reference)
    const vaultReference = await vault.put({
      description: input.body.description,
      name,
      namespace,
      value: input.body.value,
    })
    written.vault = vault
    return client.secret.create({
      data: {
        captureFingerprint: captureFingerprintForValue(input.authSecret, input.body.value),
        createdById: input.actorId,
        description: input.body.description,
        expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : undefined,
        name: input.body.name,
        organizationId: input.organizationId,
        provider: input.body.provider,
        reference: input.reference,
        scopeId: input.scopeId,
        scopeType: input.body.scopeType,
        vaultReference,
      },
    })
  }

  try {
    if (!input.idempotencyKey) {
      return { mode: 'created', secret: await create(input.prisma) }
    }
    return await input.prisma.$transaction(async (tx): Promise<CaptureResult> => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${input.organizationId}),
          hashtext(${input.reference})
        )
      `
      const existing = await tx.secret.findUnique({ where: { reference: input.reference } })
      if (existing) {
        if (!secretMatchesCaptureRequest(existing, input.body, {
          actorId: input.actorId,
          authSecret: input.authSecret,
          organizationId: input.organizationId,
          scopeId: input.scopeId,
        })) {
          throw new SecretCaptureIdempotencyConflict()
        }
        return { mode: 'replayed', secret: existing }
      }
      return { mode: 'created', secret: await create(tx) }
    })
  } catch (error) {
    if (written.vault) {
      await written.vault
        .remove({ name: vaultName(input.reference), namespace })
        .catch(() => undefined)
    }
    throw error
  }
}
