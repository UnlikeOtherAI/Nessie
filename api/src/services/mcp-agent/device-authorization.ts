import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { AgentAccessScope, PrismaClient } from '@prisma/client'

import { mintAgentAccessCredential, type MintedAgentCredential } from './agent-credential.js'

/**
 * RFC 8628 device authorization grant — how an agent with no browser gets a
 * credential.
 *
 * A CLI agent controls no browser and can host no callback URL, so the usual
 * authorization-code redirect is unavailable to it. The device grant is the
 * standard built for exactly that shape of client: the agent prints a short
 * code, a human types it into a page they are already signed in to, and the
 * agent polls until it is told what happened.
 *
 * The human step is the point, not an inconvenience. The credential this mints
 * inherits that person's entitlements, so a person has to choose to lend them —
 * nothing here creates access from nothing.
 */

/** 10 minutes: long enough to walk to a browser, short enough that an
 * abandoned pairing is not left standing. */
export const DEVICE_CODE_TTL_MS = 10 * 60_000

/** RFC 8628's polling interval, in seconds, reported to the client. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5

/**
 * No `O`/`0`, no `I`/`1`. A person reads this off one screen and types it into
 * another, and a character pair that looks identical in a sans-serif font turns
 * a working pairing into a support question.
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LENGTH = 8

export const hashDeviceCode = (deviceCode: string): string =>
  createHash('sha256').update(deviceCode).digest('hex')

const generateUserCode = (): string => {
  let code = ''
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  }
  // Grouped for reading aloud and typing: WXYZ-2345.
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export type StartedDeviceAuthorization = {
  deviceCode: string
  expiresInSeconds: number
  intervalSeconds: number
  userCode: string
}

export const startDeviceAuthorization = async (
  prisma: PrismaClient,
  input: { clientName: string; scopes: AgentAccessScope[] },
): Promise<StartedDeviceAuthorization> => {
  const deviceCode = randomBytes(32).toString('base64url')

  // The user code is unique while a request is pending, and collisions are
  // possible at 32^8. Retry a bounded number of times rather than either
  // failing the pairing or looping forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = generateUserCode()
    try {
      await prisma.agentAuthorizationRequest.create({
        data: {
          clientName: input.clientName,
          deviceCodeHash: hashDeviceCode(deviceCode),
          expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
          requestedScopes: input.scopes,
          userCode,
        },
      })
      return {
        deviceCode,
        expiresInSeconds: Math.floor(DEVICE_CODE_TTL_MS / 1000),
        intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
        userCode,
      }
    } catch (error) {
      // Only a user-code collision is worth retrying; anything else is a real
      // failure and must not be retried into a storm.
      if (!isUniqueViolation(error)) throw error
    }
  }
  throw new Error('Could not allocate a unique pairing code')
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: string }).code === 'P2002'

/**
 * The pending request behind a user code, for the approval screen.
 *
 * Returns null for anything a human should not be asked to approve — unknown,
 * already decided, or expired — so the surface shows one honest "that code is
 * not valid" rather than leaking which of those it was.
 */
export const loadPendingAuthorization = async (
  prisma: PrismaClient,
  userCode: string,
): Promise<
  | null
  | {
      clientName: string
      id: string
      requestedScopes: AgentAccessScope[]
    }
> => {
  const request = await prisma.agentAuthorizationRequest.findUnique({
    select: {
      clientName: true,
      expiresAt: true,
      id: true,
      requestedScopes: true,
      status: true,
    },
    where: { userCode: normalizeUserCode(userCode) },
  })
  if (!request || request.status !== 'pending') return null
  if (request.expiresAt.getTime() <= Date.now()) return null
  return {
    clientName: request.clientName,
    id: request.id,
    requestedScopes: request.requestedScopes,
  }
}

/** Typed by a person, so accept the shapes a person produces. */
export const normalizeUserCode = (userCode: string): string => {
  const compact = userCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.length === USER_CODE_LENGTH
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : userCode.trim().toUpperCase()
}

export type ApprovalOutcome =
  | { kind: 'approved' }
  | { kind: 'not_pending' }

/**
 * Record a human's decision.
 *
 * The approved scopes are intersected with what was requested: a screen that
 * offers fewer boxes than the agent asked for must not be able to grant more,
 * and a request cannot grow its own grant by racing the approval.
 */
export const decideDeviceAuthorization = async (
  prisma: PrismaClient,
  input: {
    approve: boolean
    approvedScopes: AgentAccessScope[]
    organizationId: string
    projectId: string
    requestId: string
    teamId: string | null
    /** The approving human's UOA workspace, replayed by the credential later. */
    uoaIdentity?: unknown
    userId: string
  },
): Promise<ApprovalOutcome> => {
  const request = await prisma.agentAuthorizationRequest.findUnique({
    select: { requestedScopes: true },
    where: { id: input.requestId },
  })
  if (!request) return { kind: 'not_pending' }

  const granted = input.approvedScopes.filter((scope) =>
    request.requestedScopes.includes(scope))

  const decided = await prisma.agentAuthorizationRequest.updateMany({
    data: input.approve
      ? {
          approvedAt: new Date(),
          approvedByUserId: input.userId,
          approvedOrganizationId: input.organizationId,
          approvedProjectId: input.projectId,
          approvedScopes: granted,
          approvedTeamId: input.teamId,
          ...(input.uoaIdentity === undefined || input.uoaIdentity === null
            ? {}
            : { approvedUoaIdentity: input.uoaIdentity as never }),
          status: 'approved',
        }
      : { status: 'denied' },
    // Conditional, so a second approver — or a decision racing the expiry
    // sweep — cannot overwrite a decision already made.
    where: {
      expiresAt: { gt: new Date() },
      id: input.requestId,
      status: 'pending',
    },
  })

  return decided.count === 1 ? { kind: 'approved' } : { kind: 'not_pending' }
}

export type DeviceTokenResult =
  | { credential: MintedAgentCredential; kind: 'issued' }
  | { kind: 'authorization_pending' }
  | { kind: 'slow_down' }
  | { kind: 'access_denied' }
  | { kind: 'expired_token' }
  | { kind: 'invalid_grant' }

/**
 * The agent's poll, and the one place a credential is minted.
 *
 * Every outcome maps to an RFC 8628 error code, because a client implementing
 * the standard already knows what to do with each: keep waiting, back off,
 * stop.
 */
export const redeemDeviceAuthorization = async (
  prisma: PrismaClient,
  input: { deviceCode: string; label?: string },
): Promise<DeviceTokenResult> => {
  const request = await prisma.agentAuthorizationRequest.findUnique({
    where: { deviceCodeHash: hashDeviceCode(input.deviceCode) },
  })
  if (!request) return { kind: 'invalid_grant' }

  // Single use. Checked before expiry so a replayed code inside the window
  // reads as an invalid grant rather than a pending one.
  if (request.redeemedAt) return { kind: 'invalid_grant' }

  if (request.expiresAt.getTime() <= Date.now()) return { kind: 'expired_token' }
  if (request.status === 'denied') return { kind: 'access_denied' }

  if (request.status === 'pending') {
    // RFC 8628 §3.5: a client polling faster than the interval is told to back
    // off rather than served, so an impatient agent cannot spin the endpoint.
    const tooSoon =
      request.lastPolledAt !== null
      && Date.now() - request.lastPolledAt.getTime()
        < DEVICE_POLL_INTERVAL_SECONDS * 1000
    await prisma.agentAuthorizationRequest.update({
      data: { lastPolledAt: new Date() },
      where: { id: request.id },
    })
    return tooSoon ? { kind: 'slow_down' } : { kind: 'authorization_pending' }
  }

  if (
    request.status !== 'approved'
    || !request.approvedOrganizationId
    || !request.approvedProjectId
    || !request.approvedByUserId
  ) {
    return { kind: 'invalid_grant' }
  }

  // Claim the redemption before minting. Two polls arriving together must not
  // produce two credentials from one approval.
  const claimed = await prisma.agentAuthorizationRequest.updateMany({
    data: { redeemedAt: new Date() },
    where: { id: request.id, redeemedAt: null, status: 'approved' },
  })
  if (claimed.count !== 1) return { kind: 'invalid_grant' }

  const credential = await mintAgentAccessCredential(prisma, {
    label: input.label?.trim() || request.clientName,
    organizationId: request.approvedOrganizationId,
    projectId: request.approvedProjectId,
    scopes: request.approvedScopes,
    teamId: request.approvedTeamId,
    uoaIdentity: request.approvedUoaIdentity,
    userId: request.approvedByUserId,
  })

  return { credential, kind: 'issued' }
}
