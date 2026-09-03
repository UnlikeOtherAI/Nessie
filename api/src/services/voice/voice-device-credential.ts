import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import type { PrismaClient, VoiceDeviceCredential } from '@prisma/client'
import { AuthorizedActionContextSchema, type AuthorizedActionContext } from '@nessie/schemas'

import { hasActiveUserSession } from '../refresh-session-management.js'
import { VoiceSessionError } from './voice-session.js'

/**
 * The one credential the native layer is allowed to hold.
 *
 * The Expo shell's standing rule is that the native app never sees an
 * authenticated Nessie session — auth lives in the WebView. A CallKit call has
 * to survive a locked screen and a suspended WebView, so that rule is amended
 * here rather than broken by accident: the native side may hold *this*, and
 * only the enumerated voice routes accept it.
 *
 * What makes it safe is that it is not a bare stateless JWT. It is a random
 * secret whose digest is a row, so every request re-runs the same revocation
 * checks an ordinary session does — the user generation, the exact sign-in it
 * derives from, live membership, and the device slot. A stolen token dies when
 * any of those does, instead of living to its expiry.
 */

/**
 * Distinguishes the credential from a session JWT at a glance.
 *
 * The auth hook has to decide which verifier to run before it can trust
 * anything, so the discriminator has to be in the token's shape rather than in
 * a claim. A JWT is three base64url segments joined by dots and can never
 * collide with this prefix.
 */
export const VOICE_CREDENTIAL_PREFIX = 'nvc1_'

/** 256 bits of randomness, base64url. Guessing is not a threat model. */
const TOKEN_BYTES = 32

/**
 * How long a minted credential lives.
 *
 * It has to cover the longest call the deployment allows plus the round trip
 * to refresh, because the refresh happens *from the native side mid-call* —
 * there is no foreground WebView to fall back on when the phone is locked. Two
 * hours against a 30-minute default call cap leaves room to raise the cap
 * without silently stranding calls.
 */
export const VOICE_CREDENTIAL_TTL_MS = 2 * 60 * 60_000

/**
 * How close to expiry a refresh starts returning a new token.
 *
 * Refreshing is cheap; a call dying at minute 29 because nobody refreshed at
 * minute 28 is not.
 */
export const VOICE_CREDENTIAL_REFRESH_WINDOW_MS = 30 * 60_000

export const hashVoiceCredential = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export const isVoiceCredentialToken = (token: string): boolean =>
  token.startsWith(VOICE_CREDENTIAL_PREFIX)

const mintToken = (): string =>
  `${VOICE_CREDENTIAL_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`

export type MintedVoiceCredential = {
  /** Returned to the caller once and never stored in this form. */
  token: string
  credential: VoiceDeviceCredential
}

/**
 * Mints a credential for one device slot.
 *
 * Called by the SPA on ordinary session auth — the WebView is the only
 * provisioning path, which is what binds the credential to a real sign-in on a
 * real device. `sessionId` is that sign-in's `sid`, so signing out kills every
 * credential it handed to the phone.
 */
export const mintVoiceDeviceCredential = async (
  prisma: PrismaClient,
  input: {
    installationId: string
    organizationId: string
    projectId: string
    sessionId: string
    teamId: string
    tokenVersion: number
    userId: string
  },
): Promise<MintedVoiceCredential> => {
  const installation = await prisma.voiceInstallation.findFirst({
    where: {
      id: input.installationId,
      organizationId: input.organizationId,
      revokedAt: null,
      userId: input.userId,
    },
  })
  if (!installation) {
    throw new VoiceSessionError(
      'VOICE_INSTALLATION_NOT_FOUND',
      'Device not found.',
      404,
    )
  }

  const token = mintToken()
  // One live credential per device slot: minting again replaces rather than
  // accumulates, so a person who reinstalls does not leave a usable token
  // behind on a phone they no longer have.
  const credential = await prisma.$transaction(async (tx) => {
    await tx.voiceDeviceCredential.updateMany({
      data: { revokedAt: new Date() },
      where: { installationId: installation.id, revokedAt: null },
    })
    return tx.voiceDeviceCredential.create({
      data: {
        expiresAt: new Date(Date.now() + VOICE_CREDENTIAL_TTL_MS),
        installationId: installation.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        teamId: input.teamId,
        tokenHash: hashVoiceCredential(token),
        tokenVersion: input.tokenVersion,
        userId: input.userId,
      },
    })
  })

  return { credential, token }
}

export type VoiceCredentialRejection =
  | 'VOICE_CREDENTIAL_INVALID'
  | 'VOICE_CREDENTIAL_EXPIRED'
  | 'VOICE_CREDENTIAL_REVOKED'

export type VoiceCredentialVerification =
  | { ok: true; actorContext: AuthorizedActionContext; credential: VoiceDeviceCredential }
  | { ok: false; code: VoiceCredentialRejection; message: string }

/**
 * Verifies a presented credential, re-running every check a session runs.
 *
 * Deliberately not a signature check. The whole reason this is server state is
 * that a locked-phone call can outlive any of these facts, and the person has
 * to be able to end it from the web: signing out, deactivating the member, or
 * revoking the device all have to take effect on the next request rather than
 * at expiry.
 */
export const verifyVoiceDeviceCredential = async (
  prisma: PrismaClient,
  token: string,
): Promise<VoiceCredentialVerification> => {
  const presented = hashVoiceCredential(token)
  const credential = await prisma.voiceDeviceCredential.findUnique({
    where: { tokenHash: presented },
  })
  if (!credential) {
    return { code: 'VOICE_CREDENTIAL_INVALID', message: 'Invalid voice credential', ok: false }
  }
  // The lookup was by digest, so this compares equal by construction; it is
  // here so the comparison is constant-time if the lookup ever becomes a scan.
  if (
    !timingSafeEqual(Buffer.from(credential.tokenHash, 'hex'), Buffer.from(presented, 'hex'))
  ) {
    return { code: 'VOICE_CREDENTIAL_INVALID', message: 'Invalid voice credential', ok: false }
  }

  if (credential.revokedAt) {
    return { code: 'VOICE_CREDENTIAL_REVOKED', message: 'Voice credential revoked', ok: false }
  }
  if (credential.expiresAt.getTime() <= Date.now()) {
    return { code: 'VOICE_CREDENTIAL_EXPIRED', message: 'Voice credential expired', ok: false }
  }

  const [user, membership, installation] = await Promise.all([
    prisma.user.findUnique({
      select: { tokenVersion: true },
      where: { id: credential.userId },
    }),
    prisma.organizationMember.findUnique({
      select: { deactivatedAt: true, role: true },
      where: {
        organizationId_userId: {
          organizationId: credential.organizationId,
          userId: credential.userId,
        },
      },
    }),
    prisma.voiceInstallation.findUnique({
      select: { revokedAt: true },
      where: { id: credential.installationId },
    }),
  ])

  // A forced sign-out bumps the user generation; a credential minted before it
  // is as dead as the access tokens are.
  if (!user || user.tokenVersion !== credential.tokenVersion) {
    return { code: 'VOICE_CREDENTIAL_REVOKED', message: 'Voice credential revoked', ok: false }
  }
  // The exact sign-in this came from. Logging out on the web has to end the
  // phone's credential too, or "sign me out everywhere" quietly means
  // "everywhere except the call in my pocket".
  if (!(await hasActiveUserSession(prisma, credential.userId, credential.sessionId))) {
    return { code: 'VOICE_CREDENTIAL_REVOKED', message: 'Voice credential revoked', ok: false }
  }
  if (!membership || membership.deactivatedAt) {
    return { code: 'VOICE_CREDENTIAL_REVOKED', message: 'Voice credential revoked', ok: false }
  }
  if (!installation || installation.revokedAt) {
    return { code: 'VOICE_CREDENTIAL_REVOKED', message: 'Voice credential revoked', ok: false }
  }

  return {
    // Parsed, never cast. This context reaches the same authorization and
    // attribution code an ordinary session's does, and a hand-built literal
    // that merely satisfies TypeScript is exactly how a required field goes
    // missing without anything failing.
    actorContext: AuthorizedActionContextSchema.parse({
      actionContext: {
        effectiveUserId: credential.userId,
        requestId: randomUUID(),
        sessionId: credential.sessionId,
      },
      actor: {
        actorId: credential.userId,
        actorType: 'user',
        // Read from the live membership, never from anything the token
        // carries, so a demotion takes effect on the next request.
        roles: [membership.role],
      },
      tenant: {
        organizationId: credential.organizationId,
        projectId: credential.projectId,
        teamId: credential.teamId,
      },
    }),
    credential,
    ok: true,
  }
}

/** Records use, so an operator can see which device is on a call right now. */
export const touchVoiceDeviceCredential = async (
  prisma: PrismaClient,
  credentialId: string,
): Promise<void> => {
  await prisma.voiceDeviceCredential
    .update({ data: { lastUsedAt: new Date() }, where: { id: credentialId } })
    .catch(() => undefined)
}

/**
 * Rotates a credential mid-call.
 *
 * The native layer refreshes itself, because a locked phone has no foreground
 * WebView to ask. Rotation revokes the presented credential and issues a
 * successor against the same device slot and the same sign-in — so refreshing
 * can never launder a credential past a sign-out that has already happened.
 */
export const rotateVoiceDeviceCredential = async (
  prisma: PrismaClient,
  credential: VoiceDeviceCredential,
): Promise<MintedVoiceCredential> => {
  const token = mintToken()
  const next = await prisma.$transaction(async (tx) => {
    const revoked = await tx.voiceDeviceCredential.updateMany({
      data: { revokedAt: new Date() },
      where: { id: credential.id, revokedAt: null },
    })
    // Two refreshes racing: the loser must not mint a second live credential.
    if (revoked.count !== 1) {
      throw new VoiceSessionError(
        'VOICE_CREDENTIAL_REVOKED',
        'Voice credential revoked',
        401,
      )
    }
    return tx.voiceDeviceCredential.create({
      data: {
        expiresAt: new Date(Date.now() + VOICE_CREDENTIAL_TTL_MS),
        installationId: credential.installationId,
        organizationId: credential.organizationId,
        projectId: credential.projectId,
        sessionId: credential.sessionId,
        teamId: credential.teamId,
        tokenHash: hashVoiceCredential(token),
        tokenVersion: credential.tokenVersion,
        userId: credential.userId,
      },
    })
  })
  return { credential: next, token }
}

/** Revokes every live credential a device slot holds. */
export const revokeVoiceDeviceCredentials = async (
  prisma: PrismaClient,
  installationId: string,
): Promise<number> => {
  const { count } = await prisma.voiceDeviceCredential.updateMany({
    data: { revokedAt: new Date() },
    where: { installationId, revokedAt: null },
  })
  return count
}
