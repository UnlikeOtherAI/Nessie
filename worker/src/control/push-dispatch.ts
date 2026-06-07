import type { PrismaClient } from '@prisma/client'
import { decryptWithKey, deriveSecretKey } from '@nessie/runtime'
import type { PushDispatchJobPayload } from '@nessie/schemas'
import {
  sendApns,
  sendFcm,
  type ApnsCredentials,
  type FcmCredentials,
  type PushPayload,
  type PushResult,
  type PushTarget,
} from '@nessie/push'

/**
 * Worker consumer for the `push.dispatch` queue topic. Resolves the recipients
 * of a freshly-posted message (channel members minus the author), loads + the
 * decrypts the stored APNs/FCM credentials, and fans a push out to each
 * recipient's registered native device tokens. Tokens the provider reports dead
 * are pruned from the registry.
 *
 * The senders, prisma client, and the auth secret are injected (see
 * {@link PushDispatchDeps}) so the handler is fully unit-testable without any
 * network or live database.
 */

/** Minimal Prisma surface the dispatch handler touches — keeps tests light. */
export type PushDispatchPrisma = Pick<
  PrismaClient,
  'pushCredential' | 'channelMember' | 'deviceToken' | 'channel' | 'mcpOAuthSecret'
>

export type PushSenders = {
  sendApns: (
    creds: ApnsCredentials,
    target: PushTarget,
    payload: PushPayload,
  ) => Promise<PushResult>
  sendFcm: (
    creds: FcmCredentials,
    target: PushTarget,
    payload: PushPayload,
  ) => Promise<PushResult>
}

export type PushDispatchDeps = {
  prisma: PushDispatchPrisma
  /** Deployment auth secret — the key the secret store encrypted creds under. */
  authSecret: string
  /** Push senders, injected so tests can stub them (default: real network). */
  senders?: PushSenders
}

export type PushDispatchSummary = {
  sent: number
  failed: number
  pruned: number
}

const decryptSecret = async (
  prisma: PushDispatchPrisma,
  authSecret: string,
  secretRef: string,
): Promise<string | null> => {
  const row = await prisma.mcpOAuthSecret.findUnique({ where: { ref: secretRef } })
  if (!row) {
    return null
  }
  return decryptWithKey(deriveSecretKey(authSecret), {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
  })
}

/**
 * Build the decrypted APNs credentials from the `push_credentials` row + the
 * `.p8` plaintext, or null if the row is incomplete / the secret is missing.
 */
const loadApnsCreds = async (
  deps: Pick<PushDispatchDeps, 'prisma' | 'authSecret'>,
  row: {
    secretRef: string
    apnsKeyId: string | null
    apnsTeamId: string | null
    apnsTopic: string | null
    apnsEnvironment: 'sandbox' | 'production' | null
  },
): Promise<ApnsCredentials | null> => {
  if (!row.apnsKeyId || !row.apnsTeamId || !row.apnsTopic) {
    return null
  }
  const p8 = await decryptSecret(deps.prisma, deps.authSecret, row.secretRef)
  if (!p8) {
    return null
  }
  return {
    p8,
    keyId: row.apnsKeyId,
    teamId: row.apnsTeamId,
    topic: row.apnsTopic,
    environment: row.apnsEnvironment ?? 'production',
  }
}

const loadFcmCreds = async (
  deps: Pick<PushDispatchDeps, 'prisma' | 'authSecret'>,
  row: { secretRef: string },
): Promise<FcmCredentials | null> => {
  const serviceAccountJson = await decryptSecret(
    deps.prisma,
    deps.authSecret,
    row.secretRef,
  )
  if (!serviceAccountJson) {
    return null
  }
  return { serviceAccountJson }
}

export const handlePushDispatch = async (
  deps: PushDispatchDeps,
  payload: PushDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const senders: PushSenders = deps.senders ?? { sendApns, sendFcm }

  // 1. Load credentials. Nothing to do if neither provider is configured.
  const credRows = await deps.prisma.pushCredential.findMany()
  const apnsRow = credRows.find((r) => r.provider === 'apns') ?? null
  const fcmRow = credRows.find((r) => r.provider === 'fcm') ?? null
  if (!apnsRow && !fcmRow) {
    return summary
  }

  const apnsCreds = apnsRow ? await loadApnsCreds(deps, apnsRow) : null
  const fcmCreds = fcmRow ? await loadFcmCreds(deps, fcmRow) : null
  if (!apnsCreds && !fcmCreds) {
    return summary
  }

  // 2. Resolve recipients: channel members minus the author.
  // TODO(push): mute/quiet-hours — no per-channel/per-user mute fields exist
  // yet, so v1 notifies every member. Mentioned users are already members.
  const members = await deps.prisma.channelMember.findMany({
    where: { channelId: payload.channelId, userId: { not: payload.authorUserId } },
    select: { userId: true },
  })
  const recipientIds = members.map((m) => m.userId)
  if (recipientIds.length === 0) {
    return summary
  }

  // 3. Load the recipients' device tokens.
  const tokens = await deps.prisma.deviceToken.findMany({
    where: { userId: { in: recipientIds } },
  })
  if (tokens.length === 0) {
    return summary
  }

  // 4. Build the notification payload (deep-link data + per-channel coalescing).
  const channel = await deps.prisma.channel.findUnique({
    where: { id: payload.channelId },
    select: { label: true },
  })
  const pushPayload: PushPayload = {
    title: channel?.label ?? 'New message',
    body: payload.contentSnippet,
    data: {
      channelId: payload.channelId,
      threadId: payload.threadId,
      messageId: payload.messageId,
    },
    collapseId: payload.channelId,
  }

  // 5. Deliver per-token; prune dead tokens; never throw out of the loop.
  const deadTokenIds: string[] = []
  for (const token of tokens) {
    try {
      let result: PushResult | null = null
      if (token.platform === 'ios' && apnsCreds) {
        result = await senders.sendApns(apnsCreds, { token: token.token }, pushPayload)
      } else if (token.platform === 'android' && fcmCreds) {
        result = await senders.sendFcm(fcmCreds, { token: token.token }, pushPayload)
      } else {
        // No configured provider for this platform — skip silently.
        continue
      }

      if (result.ok) {
        summary.sent += 1
      } else {
        summary.failed += 1
      }
      if (result.deadToken) {
        deadTokenIds.push(token.id)
      }
    } catch (err) {
      summary.failed += 1
      console.error('[push-dispatch] send failed', {
        tokenId: token.id,
        platform: token.platform,
        err,
      })
    }
  }

  if (deadTokenIds.length > 0) {
    await deps.prisma.deviceToken.deleteMany({ where: { id: { in: deadTokenIds } } })
    summary.pruned = deadTokenIds.length
  }

  console.log('[push-dispatch] done', {
    messageId: payload.messageId,
    channelId: payload.channelId,
    recipients: recipientIds.length,
    tokens: tokens.length,
    sent: summary.sent,
    failed: summary.failed,
    pruned: summary.pruned,
  })

  return summary
}
