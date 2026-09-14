import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DeviceToken, PrismaClient } from '@prisma/client'
import type { RegisterDeviceRequest } from '@nessie/schemas'

export type DeviceRegistrationResult =
  | { device: DeviceToken; kind: 'registered'; ownershipProof?: string }
  | { device: DeviceToken; kind: 'ownership_proof_required' | 'stale' }

type RegistrationInput = RegisterDeviceRequest & {
  organizationId: string
  registrationVersion: bigint
  userId: string
}

const ownershipProofHash = (proof: string): string =>
  createHash('sha256').update(proof).digest('base64url')

const deviceRecoveryKeyHash = (key: string): string =>
  createHash('sha256').update(key).digest('base64url')

const proofMatches = (storedHash: string | null, suppliedProof: string | undefined): boolean => {
  if (!storedHash || !suppliedProof) return false
  const suppliedHash = ownershipProofHash(suppliedProof)
  return storedHash.length === suppliedHash.length
    && timingSafeEqual(Buffer.from(storedHash), Buffer.from(suppliedHash))
}

const issueOwnershipProof = (): string => randomBytes(32).toString('base64url')

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'

/**
 * Registers one physical installation. A native push token is routing data,
 * not proof of possession: moving it between people requires the installation
 * proof that was issued when the device first registered or last transferred.
 */
export const registerDeviceToken = async (
  prisma: Pick<PrismaClient, 'deviceToken'>,
  input: RegistrationInput,
): Promise<DeviceRegistrationResult> => {
  const updateData = {
    apnsEnvironment: input.platform === 'ios' ? input.apnsEnvironment ?? null : null,
    appVersion: input.appVersion ?? null,
    inactiveAt: null,
    lastSeenAt: new Date(),
    organizationId: input.organizationId,
    platform: input.platform,
    registrationVersion: input.registrationVersion,
    userId: input.userId,
  }

  // A concurrent first registration can win the unique token race. Re-read it
  // once and apply the same proof/generation decision to the resulting row.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await prisma.deviceToken.findUnique({ where: { token: input.token } })
    if (!current) {
      const ownershipProof = issueOwnershipProof()
      try {
        const device = await prisma.deviceToken.create({
          data: {
            ...updateData,
            ...(input.deviceRecoveryKey
              ? { deviceRecoveryKeyHash: deviceRecoveryKeyHash(input.deviceRecoveryKey) }
              : {}),
            ownershipProofHash: ownershipProofHash(ownershipProof),
            token: input.token,
          },
        })
        return { device, kind: 'registered', ownershipProof }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        continue
      }
    }

    if (current.registrationVersion > input.registrationVersion) {
      return { device: current, kind: 'stale' }
    }

    const sameOwner = current.organizationId === input.organizationId && current.userId === input.userId
    const requiresProof = !sameOwner || current.inactiveAt !== null
    const recoveryKeyMatches = proofMatches(
      current.deviceRecoveryKeyHash,
      input.deviceRecoveryKey,
    )
    const canBootstrapLegacyTombstone = sameOwner
      && current.inactiveAt !== null
      && !current.deviceRecoveryKeyHash
      && input.registrationVersion > current.registrationVersion
    const proofMatchesCurrent = proofMatches(current.ownershipProofHash, input.ownershipProof)
    if (requiresProof && !proofMatchesCurrent && !recoveryKeyMatches && !canBootstrapLegacyTombstone) {
      return { device: current, kind: 'ownership_proof_required' }
    }

    // Existing rows receive their first proof on an active same-owner refresh.
    // A transfer or tombstone revival rotates it so the former account cannot
    // rebind this physical installation later.
    const recoveryKeyHash = !current.deviceRecoveryKeyHash && input.deviceRecoveryKey
      ? deviceRecoveryKeyHash(input.deviceRecoveryKey)
      : undefined
    const ownershipProof = (!current.ownershipProofHash
      || requiresProof
      || (recoveryKeyMatches && !input.ownershipProof)
      || recoveryKeyHash
    ) ? issueOwnershipProof() : undefined
    const changed = await prisma.deviceToken.updateMany({
      where: {
        token: input.token,
        registrationVersion: { lte: input.registrationVersion },
        ...(requiresProof ? { ownershipProofHash: current.ownershipProofHash } : {
          organizationId: input.organizationId,
          userId: input.userId,
        }),
        ...(recoveryKeyHash ? { deviceRecoveryKeyHash: null } : {}),
      },
      data: {
        ...updateData,
        ...(ownershipProof ? { ownershipProofHash: ownershipProofHash(ownershipProof) } : {}),
        ...(recoveryKeyHash
          ? { deviceRecoveryKeyHash: recoveryKeyHash }
          : {}),
      },
    })
    if (changed.count === 1) {
      const device = await prisma.deviceToken.findUnique({ where: { token: input.token } })
      if (!device) throw new Error('Device token was not persisted')
      return { device, kind: 'registered', ...(ownershipProof ? { ownershipProof } : {}) }
    }
  }

  const device = await prisma.deviceToken.findUnique({ where: { token: input.token } })
  if (!device) throw new Error('Device token was not persisted')
  return { device, kind: 'stale' }
}
