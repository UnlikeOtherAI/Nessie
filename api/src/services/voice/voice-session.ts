import type { PrismaClient, VoiceInstallation, VoiceSession } from '@prisma/client'
import type { LedgerIdentityService } from '@nessie/runtime'
import type { AuthorizedActionContext, VoiceInstallationPlatform } from '@nessie/schemas'

import { LedgerVoiceError, ledgerDeviceId, mintVoiceCredential } from './ledger-gemini-live.js'
import { resolveVoiceLimits } from './voice-context.js'

/**
 * Voice-call lifecycle: registering an installation, starting a call, and
 * rotating its credential.
 *
 * Two caps live here and nowhere else, because both protect a shared, real
 * resource: Ledger reserves daily budget per device slot, so unlimited
 * installations or unlimited mints would drain the deployment's whole Gemini
 * budget from one account.
 */

/**
 * How many live installations one person may hold.
 *
 * Generous enough for a laptop, a desktop, a phone and a spare; small enough
 * that it cannot be used to multiply Ledger's per-device reservations.
 */
const DEFAULT_MAX_INSTALLATIONS_PER_USER = 6

/** Mints per user per rolling day, covering rotations on long calls. */
const DEFAULT_MAX_DAILY_MINTS_PER_USER = 60

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export class VoiceSessionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'VoiceSessionError'
    this.code = code
    this.status = status
  }
}

export type RegisterInstallationInput = {
  organizationId: string
  userId: string
  platform: VoiceInstallationPlatform
  label?: string | undefined
  env?: NodeJS.ProcessEnv
}

/**
 * Registers a browser or app, refusing past the per-user cap.
 *
 * The caller never proposes an identifier — the row id *is* the identity, and
 * the value Ledger sees is derived from it. Reaching the cap is a refusal
 * rather than an eviction: silently revoking someone's other device to make
 * room would break a call in progress on it.
 */
export const registerVoiceInstallation = async (
  prisma: PrismaClient,
  input: RegisterInstallationInput,
): Promise<VoiceInstallation> => {
  const max = positiveInt(
    (input.env ?? process.env)['NESSIE_VOICE_MAX_INSTALLATIONS_PER_USER'],
    DEFAULT_MAX_INSTALLATIONS_PER_USER,
  )
  const active = await prisma.voiceInstallation.count({
    where: { userId: input.userId, organizationId: input.organizationId, revokedAt: null },
  })
  if (active >= max) {
    throw new VoiceSessionError(
      'VOICE_INSTALLATION_LIMIT',
      `You already have ${active} devices set up for voice calls. Remove one before adding another.`,
      409,
    )
  }
  return prisma.voiceInstallation.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      platform: input.platform,
      ...(input.label ? { label: input.label } : {}),
    },
  })
}

/** Resolves an installation the caller owns, or explains why it cannot. */
export const requireOwnedInstallation = async (
  prisma: PrismaClient,
  input: { installationId: string; organizationId: string; userId: string },
): Promise<VoiceInstallation> => {
  const installation = await prisma.voiceInstallation.findFirst({
    where: {
      id: input.installationId,
      organizationId: input.organizationId,
      userId: input.userId,
    },
  })
  // Indistinguishable from "belongs to somebody else": an installation id is a
  // global UUID, and confirming one exists would leak that.
  if (!installation) {
    throw new VoiceSessionError('VOICE_INSTALLATION_NOT_FOUND', 'Device not found.', 404)
  }
  if (installation.revokedAt) {
    throw new VoiceSessionError(
      'VOICE_INSTALLATION_REVOKED',
      'This device was removed from voice calling.',
      403,
    )
  }
  return installation
}

const assertDailyMintBudget = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; env: NodeJS.ProcessEnv },
): Promise<void> => {
  const max = positiveInt(
    input.env['NESSIE_VOICE_MAX_DAILY_MINTS_PER_USER'],
    DEFAULT_MAX_DAILY_MINTS_PER_USER,
  )
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  // Rotations count: they are real Ledger mints, and a client stuck in a
  // reconnect loop is exactly the case this bound exists for.
  const mints = await prisma.voiceSession.aggregate({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      startedAt: { gte: since },
    },
    _count: { _all: true },
    _sum: { rotationCount: true },
  })
  const used = mints._count._all + (mints._sum.rotationCount ?? 0)
  if (used >= max) {
    throw new VoiceSessionError(
      'VOICE_DAILY_LIMIT',
      'You have reached today’s voice-calling limit. Try again later.',
      429,
    )
  }
}

export type StartVoiceSessionInput = {
  actorContext: AuthorizedActionContext
  agentId: string
  authSecret: string
  channelId: string
  installation: VoiceInstallation
  ledgerIdentity: LedgerIdentityService | null
  threadId: string
  env?: NodeJS.ProcessEnv
}

/**
 * Mints a credential and records the call.
 *
 * The UOA tuple is captured here, once, and every later relay for this call
 * re-signs against it rather than re-reading the request's ambient workspace —
 * which can drift to another team mid-call and would silently move the call's
 * billing with it.
 */
export const startVoiceSession = async (
  prisma: PrismaClient,
  input: StartVoiceSessionInput,
): Promise<{ session: VoiceSession; accessToken: string; websocketUrl: string; newSessionExpiresAt: string }> => {
  const env = input.env ?? process.env
  const organizationId = input.actorContext.tenant.organizationId
  const userId = input.actorContext.actor.actorId

  await assertDailyMintBudget(prisma, { env, organizationId, userId })

  const credential = await mintVoiceCredential({
    actorContext: input.actorContext,
    deviceId: ledgerDeviceId(input.installation.id, input.authSecret),
    ledgerIdentity: input.ledgerIdentity,
    env,
  })

  const expiresAt = new Date(credential.expiresAt)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new LedgerVoiceError(
      'VOICE_LEDGER_RESPONSE_INVALID',
      'Ledger returned an unparseable credential expiry.',
    )
  }

  const limits = resolveVoiceLimits(env)
  const uoa = input.actorContext.actionContext.uoaIdentity
  const session = await prisma.voiceSession.create({
    data: {
      organizationId,
      userId,
      installationId: input.installation.id,
      channelId: input.channelId,
      threadId: input.threadId,
      agentId: input.agentId,
      uoaSubject: uoa?.subject ?? null,
      uoaOrganizationId: uoa?.organizationId ?? null,
      uoaTeamId: uoa?.teamId ?? null,
      uoaTokenVersion: uoa?.tokenVersion ?? null,
      ledgerSessionId: credential.sessionId,
      model: credential.model,
      credentialExpiresAt: expiresAt,
      maxDurationMs: limits.maxDurationMs,
      maxToolCalls: limits.maxToolCalls,
    },
  })

  await prisma.voiceInstallation.update({
    where: { id: input.installation.id },
    data: { lastSeenAt: new Date() },
  })

  return {
    session,
    accessToken: credential.accessToken,
    websocketUrl: credential.websocketUrl,
    newSessionExpiresAt: credential.newSessionExpiresAt,
  }
}

/**
 * Loads a call the caller owns and may still act on.
 *
 * An ended call is refused rather than reopened: its transcript slot may
 * already be spent, and its Ledger session is closed.
 */
export const requireActiveSession = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; userId: string },
): Promise<VoiceSession> => {
  const session = await prisma.voiceSession.findFirst({
    where: {
      id: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
    },
  })
  if (!session) {
    throw new VoiceSessionError('VOICE_SESSION_NOT_FOUND', 'Call not found.', 404)
  }
  if (session.status !== 'active') {
    throw new VoiceSessionError('VOICE_SESSION_ENDED', 'This call has ended.', 409)
  }
  return session
}

/** True once a call has run past its wall-clock ceiling. */
export const hasExceededDuration = (session: VoiceSession, now = new Date()): boolean =>
  now.getTime() - session.startedAt.getTime() > session.maxDurationMs

/**
 * Loads a call whose record has not been written yet.
 *
 * Deliberately accepts an *ended* call, not only a live one. A client that
 * died mid-call submits its transcript on a later launch, and a call can also
 * be ended by its own duration cap or by a second tab — refusing those would
 * throw away exactly the records hardest to reproduce. The single-record
 * guarantee comes from the set-once transcript slot, not from the status.
 */
export const requireRecordableSession = async (
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; userId: string },
): Promise<VoiceSession> => {
  const session = await prisma.voiceSession.findFirst({
    where: {
      id: input.sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
    },
  })
  if (!session) {
    throw new VoiceSessionError('VOICE_SESSION_NOT_FOUND', 'Call not found.', 404)
  }
  if (session.transcriptMessageId) {
    throw new VoiceSessionError(
      'VOICE_TRANSCRIPT_ALREADY_RECORDED',
      'This call already has a record.',
      409,
    )
  }
  return session
}

export type RotateVoiceSessionInput = {
  actorContext: AuthorizedActionContext
  authSecret: string
  ledgerIdentity: LedgerIdentityService | null
  session: VoiceSession
  env?: NodeJS.ProcessEnv
}

/**
 * Replaces the Google credential for a call already in progress.
 *
 * The voice session id, its seeded context and its transcript slot all
 * survive; only `ledgerSessionId` moves. Minting a fresh voice session per
 * rotation would split one call's usage stream across two rows and let it
 * write two call records.
 */
export const rotateVoiceSession = async (
  prisma: PrismaClient,
  input: RotateVoiceSessionInput,
): Promise<{ session: VoiceSession; accessToken: string; websocketUrl: string; newSessionExpiresAt: string }> => {
  const env = input.env ?? process.env
  if (hasExceededDuration(input.session)) {
    throw new VoiceSessionError(
      'VOICE_SESSION_DURATION_LIMIT',
      'This call reached its time limit.',
      409,
    )
  }
  await assertDailyMintBudget(prisma, {
    env,
    organizationId: input.session.organizationId,
    userId: input.session.userId,
  })

  const credential = await mintVoiceCredential({
    actorContext: input.actorContext,
    deviceId: ledgerDeviceId(input.session.installationId, input.authSecret),
    ledgerIdentity: input.ledgerIdentity,
    env,
  })
  const expiresAt = new Date(credential.expiresAt)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new LedgerVoiceError(
      'VOICE_LEDGER_RESPONSE_INVALID',
      'Ledger returned an unparseable credential expiry.',
    )
  }

  // Conditional on the session still being active so a rotation racing an end
  // cannot resurrect a finished call.
  const updated = await prisma.voiceSession.updateMany({
    where: { id: input.session.id, status: 'active' },
    data: {
      ledgerSessionId: credential.sessionId,
      model: credential.model,
      credentialExpiresAt: expiresAt,
      rotationCount: { increment: 1 },
    },
  })
  if (updated.count !== 1) {
    throw new VoiceSessionError('VOICE_SESSION_ENDED', 'This call has ended.', 409)
  }

  const session = await prisma.voiceSession.findUniqueOrThrow({ where: { id: input.session.id } })
  return {
    session,
    accessToken: credential.accessToken,
    websocketUrl: credential.websocketUrl,
    newSessionExpiresAt: credential.newSessionExpiresAt,
  }
}

/**
 * Marks a call finished.
 *
 * `usageComplete` stays false unless the client's final usage report actually
 * landed — spend nobody can attribute is a fact worth keeping, not one to
 * paper over by assuming completion at hang-up.
 */
export const endVoiceSession = async (
  prisma: PrismaClient,
  sessionId: string,
  outcome: 'ended' | 'failed' = 'ended',
): Promise<void> => {
  await prisma.voiceSession.updateMany({
    where: { id: sessionId, status: 'active' },
    data: { status: outcome, endedAt: new Date() },
  })
}
