import { randomUUID } from 'node:crypto'

import { type Prisma, type PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  deriveRefreshTokenSuccessor,
  hashRefreshToken,
} from './refresh-token-crypto.js'
import {
  lockRefreshFamily,
  refreshTokenSelect,
  resolveReplayDescendant,
  revokeRefreshFamily,
  revokeRefreshFamilyRows,
  type RefreshTokenRecord,
} from './refresh-token-family.js'
import {
  identityFromCredential,
  loadBoundUoaCredential,
  prepareUoaRefresh,
  UoaRefreshBindingError,
  validateUoaRefresh,
  type RotatedUoaCredential,
  type UoaCredentialRecord,
} from './refresh-token-uoa.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from './user-session-lock.js'
import {
  ensureUoaWorkspaceSwitchIntent,
  identityMatchesTarget,
  loadUoaWorkspaceSwitchIntent,
  targetFromIntent,
  UoaWorkspaceSwitchError,
  type UoaWorkspaceSwitchIntentRecord,
} from './uoa-workspace-switch-intent.js'
import type { UoaWorkspaceSwitchTarget } from './uoa-session.js'
import type { ExternalAuthWorkspace } from './identity-display.js'
import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'
import type { ConsumeRefreshTokenResult } from './refresh-token-result.js'
import {
  assertWorkspaceSwitchSource,
  clearRefusedWorkspaceSwitchIntent,
  commitUoaRotation,
  revalidateWorkspaceSwitchIntent,
  type UoaRotationCallbacks,
} from './refresh-token-uoa-rotation.js'

export { hashRefreshToken } from './refresh-token-crypto.js'
export {
  issueRefreshToken,
  RefreshTokenIssuanceError,
} from './refresh-token-issuance.js'

export { REFRESH_TOKEN_REPLAY_GRACE_MS } from './refresh-token-family.js'
export { revokeRefreshFamily as revokeFamily } from './refresh-token-family.js'
export { UoaRefreshBindingError } from './refresh-token-uoa.js'
export { UoaWorkspaceSwitchError } from './uoa-workspace-switch-intent.js'
export type { ConsumeRefreshTokenResult } from './refresh-token-result.js'

type ConsumeInput = UoaRotationCallbacks & {
  authSecret: string
  rawToken: string
  ttlSeconds: number
  refreshUoaSession?: (input: {
    configUrl: string
    expectedIdentity: UoaSessionIdentity
    refreshToken: string
    userId: string
    workspaceSwitch?: UoaWorkspaceSwitchTarget
  }) => Promise<{
    identity: UoaSessionIdentity
    refreshToken: string
    refreshTokenExpiresAt: Date
    workspace?: ExternalAuthWorkspace
    workspaceDirectory?: UoaWorkspaceDirectoryEntry[]
  }>
  beforeUoaWorkspaceSwitch?: (input: {
    sourceIdentity: UoaSessionIdentity
    target: UoaWorkspaceSwitchTarget
    userId: string
  }) => Promise<void>
  uoaWorkspaceSwitch?: {
    sourceIdentity: UoaSessionIdentity
    sourceProviderId: string
    sourceSessionId: string
    sourceUserId: string
    target: UoaWorkspaceSwitchTarget
  }
  userAgent?: string | null
  now?: Date
  clock?: () => Date
}

type RefreshPreflight =
  | { kind: 'result'; result: ConsumeRefreshTokenResult }
  | {
      kind: 'rotate'
      presented: RefreshTokenRecord
      uoa: {
        credential: UoaCredentialRecord
        expectedIdentity: UoaSessionIdentity
        intent: UoaWorkspaceSwitchIntentRecord | null
        intentWasPending: boolean
        refreshToken: string
      } | null
    }

type RefreshCredentialStore = Pick<
  Prisma.TransactionClient,
  'uoaSessionCredential' | 'uoaWorkspaceSwitchIntent'
>

const successResult = async (
  prisma: RefreshCredentialStore,
  record: RefreshTokenRecord,
  rawToken: string,
  replayed: boolean,
): Promise<ConsumeRefreshTokenResult> => {
  const uoaIdentity = record.providerType === 'uoa'
    ? identityFromCredential(await loadBoundUoaCredential(prisma, record))
    : undefined
  return {
    ok: true,
    expiresAt: record.expiresAt,
    familyId: record.familyId,
    rawToken,
    replayed,
    sessionId: record.sessionId,
    userId: record.userId,
    providerId: record.providerId,
    providerType: record.providerType,
    ...(uoaIdentity ? { uoaIdentity } : {}),
  }
}

// Consume an active refresh token and create its deterministic successor. UOA
// renewal runs between two short family-locked transactions: its refresh-token
// endpoint deterministically replays one exact successor, so concurrent or
// response-loss retries may safely perform the same network call while the
// local compare-and-swap converges on one successor. No external I/O holds a DB
// connection or advisory lock. A predecessor presented after the local grace
// window remains theft-signalling reuse and revokes the family.
export const consumeRefreshToken = async (
  prisma: PrismaClient,
  input: ConsumeInput,
): Promise<ConsumeRefreshTokenResult> => {
  const tokenHash = hashRefreshToken(input.rawToken)
  const familyHint = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { familyId: true },
  })
  if (!familyHint) {
    return { ok: false, reason: 'invalid' }
  }

  const readClock = (): Date => input.clock?.() ?? input.now ?? new Date()
  const preflight: RefreshPreflight = await prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyHint.familyId)
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.familyId !== familyHint.familyId) {
      return {
        kind: 'result',
        result: { ok: false, reason: 'invalid' },
      }
    }

    const requestTime = readClock()
    if (presented.revokedAt || presented.replacedById) {
      if (
        input.uoaWorkspaceSwitch
        && (
          presented.userId !== input.uoaWorkspaceSwitch.sourceUserId
          || presented.providerId !== input.uoaWorkspaceSwitch.sourceProviderId
          || presented.providerType !== 'uoa'
          || presented.sessionId !== input.uoaWorkspaceSwitch.sourceSessionId
        )
      ) {
        throw new UoaWorkspaceSwitchError(
          'WORKSPACE_SWITCH_CONFLICT',
          'The UnlikeOtherAI access token and refresh cookie do not identify the same session.',
          false,
        )
      }
      const replay = await resolveReplayDescendant(tx, {
        authSecret: input.authSecret,
        now: requestTime,
        root: presented,
        rootRawToken: input.rawToken,
      })
      const result = replay.ok
        ? await successResult(tx, replay.record, replay.rawToken, true)
        : replay
      if (
        input.uoaWorkspaceSwitch
        && result.ok
        && (
          !result.uoaIdentity
          || result.uoaIdentity.subject
            !== input.uoaWorkspaceSwitch.sourceIdentity.subject
          || !identityMatchesTarget(
            result.uoaIdentity,
            input.uoaWorkspaceSwitch.target,
          )
        )
      ) {
        throw new UoaWorkspaceSwitchError(
          'WORKSPACE_SWITCH_CONFLICT',
          'A different session rotation completed before this workspace switch.',
          false,
        )
      }
      return {
        kind: 'result',
        result,
      }
    }
    if (presented.expiresAt.getTime() <= requestTime.getTime()) {
      await revokeRefreshFamilyRows(tx, presented.familyId, requestTime)
      return { kind: 'result', result: { ok: false, reason: 'expired' } }
    }
    if (presented.providerType !== 'uoa') {
      if (input.uoaWorkspaceSwitch) {
        throw new UoaRefreshBindingError(
          'This refresh session is not backed by UnlikeOtherAI.',
        )
      }
      if (
        presented.replayProtectedUntil
        && presented.replayProtectedUntil.getTime() > requestTime.getTime()
      ) {
        return {
          kind: 'result',
          result: await successResult(tx, presented, input.rawToken, true),
        }
      }
      return { kind: 'rotate', presented, uoa: null }
    }
    if (!input.refreshUoaSession || !input.advanceUoaSessionBinding) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI refresh is not configured for this session.',
      )
    }
    const prepared = await prepareUoaRefresh(tx, {
      authSecret: input.authSecret,
      now: requestTime,
      presented,
    })
    if (input.uoaWorkspaceSwitch) {
      assertWorkspaceSwitchSource(
        input.uoaWorkspaceSwitch,
        presented,
        prepared.expectedIdentity,
      )
    }
    const pendingIntent = await loadUoaWorkspaceSwitchIntent(tx, {
      credential: prepared.credential,
      presented,
    })
    const intent = input.uoaWorkspaceSwitch
      ? await ensureUoaWorkspaceSwitchIntent(tx, {
          credential: prepared.credential,
          presented,
          target: input.uoaWorkspaceSwitch.target,
        })
      : pendingIntent
    if (
      presented.replayProtectedUntil
      && presented.replayProtectedUntil.getTime() > requestTime.getTime()
      && !intent
    ) {
      return {
        kind: 'result',
        result: await successResult(tx, presented, input.rawToken, true),
      }
    }
    if (intent && (!input.beforeUoaWorkspaceSwitch || !input.rescopeUoaSessionBinding)) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI workspace switching is not configured for this session.',
      )
    }
    return {
      kind: 'rotate',
      presented,
      uoa: { ...prepared, intent, intentWasPending: Boolean(pendingIntent) },
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)

  if (preflight.kind === 'result') {
    return preflight.result
  }

  let rotatedUoa: RotatedUoaCredential | null = null
  const rotatedUoaIntent = preflight.uoa?.intent ?? null
  if (preflight.uoa) {
    try {
      const workspaceSwitch = rotatedUoaIntent
        ? targetFromIntent(rotatedUoaIntent)
        : undefined
      if (rotatedUoaIntent && workspaceSwitch) {
        await revalidateWorkspaceSwitchIntent(prisma, {
          intent: rotatedUoaIntent,
          presented: preflight.presented,
        })
        await input.beforeUoaWorkspaceSwitch!({
          sourceIdentity: preflight.uoa.expectedIdentity,
          target: workspaceSwitch,
          userId: preflight.presented.userId,
        })
        // Direct access confirmation intentionally happens outside the family
        // transaction. Recheck the exact intent and source credential
        // immediately before presenting that credential to UOA, closing the
        // intervening race without holding a DB lock over network I/O.
        await revalidateWorkspaceSwitchIntent(prisma, {
          intent: rotatedUoaIntent,
          presented: preflight.presented,
        })
      }
      const refreshed = await input.refreshUoaSession!({
        configUrl: preflight.uoa.credential.configUrl,
        expectedIdentity: preflight.uoa.expectedIdentity,
        refreshToken: preflight.uoa.refreshToken,
        userId: preflight.presented.userId,
        ...(workspaceSwitch ? { workspaceSwitch } : {}),
      })
      rotatedUoa = validateUoaRefresh({
        authSecret: input.authSecret,
        credential: preflight.uoa.credential,
        expectedIdentity: preflight.uoa.expectedIdentity,
        identity: refreshed.identity,
        now: readClock(),
        refreshToken: refreshed.refreshToken,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        workspace: refreshed.workspace,
        workspaceDirectory: refreshed.workspaceDirectory,
        ...(workspaceSwitch ? { targetIdentity: workspaceSwitch } : {}),
      })
    } catch (error) {
      if (
        rotatedUoaIntent
        && error instanceof UoaWorkspaceSwitchError
        && error.clearIntent
      ) {
        if (preflight.uoa.intentWasPending) {
          // A previous attempt may already have committed UOA's deterministic
          // target edge. Preserving the old local credential after a resumed
          // refusal would strand the family on a consumed predecessor.
          throw new UoaRefreshBindingError(
            'The pending UnlikeOtherAI workspace switch can no longer be resumed.',
          )
        }
        await clearRefusedWorkspaceSwitchIntent(prisma, {
          intent: rotatedUoaIntent,
          presented: preflight.presented,
        })
      }
      throw error
    }
  }

  return prisma.$transaction(async (tx) => {
    await lockRefreshFamily(tx, familyHint.familyId)
    const presented = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: refreshTokenSelect,
    }) as RefreshTokenRecord | null
    if (!presented || presented.familyId !== familyHint.familyId) {
      return { ok: false, reason: 'invalid' }
    }

    // The decision clock is intentionally read after the upstream round trip.
    // A slow successful UOA refresh must not consume the local response-loss
    // grace period before its deterministic successor is committed.
    const commitTime = readClock()
    if (presented.revokedAt || presented.replacedById) {
      const replay = await resolveReplayDescendant(tx, {
        authSecret: input.authSecret,
        now: commitTime,
        root: presented,
        rootRawToken: input.rawToken,
      })
      const result = replay.ok
        ? await successResult(tx, replay.record, replay.rawToken, true)
        : replay
      if (
        rotatedUoaIntent
        && result.ok
        && (
          !result.uoaIdentity
          || !identityMatchesTarget(
            result.uoaIdentity,
            targetFromIntent(rotatedUoaIntent),
          )
        )
      ) {
        throw new UoaWorkspaceSwitchError(
          'WORKSPACE_SWITCH_CONFLICT',
          'A different session rotation completed before this workspace switch.',
          false,
        )
      }
      return result
    }
    if (presented.expiresAt.getTime() <= commitTime.getTime()) {
      await revokeRefreshFamilyRows(tx, presented.familyId, commitTime)
      return { ok: false, reason: 'expired' }
    }
    if (
      presented.replayProtectedUntil
      && presented.replayProtectedUntil.getTime() > commitTime.getTime()
    ) {
      if (rotatedUoa) {
        // An ancestor replay won while UOA renewal was in flight. Keep the
        // barrier's local cookie, but adopt the exact replay-safe upstream
        // successor in place so the two credential chains cannot diverge.
        await commitUoaRotation(
          tx,
          input,
          presented,
          rotatedUoa,
          presented.id,
          rotatedUoaIntent,
        )
      }
      return successResult(tx, presented, input.rawToken, true)
    }

    const successorId = randomUUID()
    const successorRawToken = deriveRefreshTokenSuccessor(
      input.rawToken,
      input.authSecret,
    )
    const successorExpiresAt = new Date(
      commitTime.getTime() + input.ttlSeconds * 1000,
    )
    const claimed = await tx.refreshToken.updateMany({
      where: { id: presented.id, revokedAt: null, replacedById: null },
      data: { revokedAt: commitTime, replacedById: successorId },
    })
    if (claimed.count !== 1) {
      return { ok: false, reason: 'invalid' }
    }
    await tx.refreshToken.create({
      data: {
        id: successorId,
        userId: presented.userId,
        sessionId: presented.sessionId,
        providerId: presented.providerId,
        providerType: presented.providerType,
        familyId: presented.familyId,
        tokenHash: hashRefreshToken(successorRawToken),
        expiresAt: successorExpiresAt,
        userAgent: input.userAgent ?? undefined,
      },
    })
    if (rotatedUoa) {
      await commitUoaRotation(
        tx,
        input,
        presented,
        rotatedUoa,
        successorId,
        rotatedUoaIntent,
      )
    }

    return successResult(
      tx,
      {
        ...presented,
        id: successorId,
        tokenHash: hashRefreshToken(successorRawToken),
        revokedAt: null,
        replacedById: null,
        replayProtectedUntil: null,
        expiresAt: successorExpiresAt,
      },
      successorRawToken,
      false,
    )
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

// Logout: revoke the family of the presented token. Missing/unknown tokens are
// a no-op so logout is always idempotent. Returns the owning user id when a
// family was actually revoked, so the caller can also bump that user's
// tokenVersion and kill their outstanding access token.
export const revokeRefreshTokenByRaw = async (
  prisma: PrismaClient,
  rawToken: string,
): Promise<{ userId: string } | null> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { familyId: true, userId: true },
  })
  if (!record) return null
  await revokeRefreshFamily(prisma, record.familyId)
  return { userId: record.userId }
}
