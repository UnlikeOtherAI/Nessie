import type { PrismaClient } from '@prisma/client'
import type { EncryptionKeyRingInput } from '@nessie/runtime'
import { ExecutorSessionScreenSchema, type AuthorizedActionContext, type ExecutorSessionViewExchange } from '@nessie/schemas'

import { decryptExecutorCommandJson, encryptExecutorCommandJson } from './executor-command-codec.js'
import { authorizeExecutorDaemonControlCall } from './executor-daemon.js'
import { requireHostSession, sessionSummary, type HostSessionId } from './executor-session-access.js'

const VIEW_TTL_MS = 30_000

export const readExecutorSessionView = async (
  prisma: PrismaClient, encryptionSecret: EncryptionKeyRingInput, actor: AuthorizedActionContext,
  input: HostSessionId, now = new Date(),
) => {
  const { row, canShare } = await requireHostSession(prisma, actor, input)
  await prisma.executorHostSession.update({
    where: { executorId_sessionId: input }, data: { requestedUntil: new Date(now.getTime() + VIEW_TTL_MS) },
  })
  const fresh = row.capturedAt && row.capturedAt.getTime() > now.getTime() - VIEW_TTL_MS
  return {
    online: row.executor.status === 'online' && Boolean(row.executor.lastSeenAt
      && now.getTime() - row.executor.lastSeenAt.getTime() < 60_000),
    session: sessionSummary(row), canShare,
    screen: fresh && row.screenCiphertext
      ? ExecutorSessionScreenSchema.parse(decryptExecutorCommandJson(encryptionSecret, row.screenCiphertext))
      : null,
  }
}

/** Signed outbound relay: persistent metadata, short-lived encrypted screens and viewer demand. */
export const exchangeExecutorSessionViews = async (
  prisma: PrismaClient, encryptionSecret: EncryptionKeyRingInput, input: ExecutorSessionViewExchange, now = new Date(),
) => {
  const { signature, ...payload } = input
  return authorizeExecutorDaemonControlCall(prisma, {
    ...input, signature, payload, type: 'session_view',
  }, async (tx) => {
    for (const session of input.sessions ?? []) {
      const { sessionId, ownerKey, title, root, agent, status } = session
      const metadata = { title, root, agent, status, reportedAt: new Date(session.updatedAt) }
      // A UUID's owner is immutable; an unrelated report cannot redirect an existing share.
      await tx.executorHostSession.createMany({
        data: [{ executorId: input.executorId, sessionId, ownerKey, ...metadata, requestedUntil: new Date(0) }],
        skipDuplicates: true,
      })
      await tx.executorHostSession.updateMany({
        where: { executorId: input.executorId, sessionId, ownerKey, reportedAt: { lte: metadata.reportedAt } },
        data: metadata,
      })
    }
    await tx.executorHostSession.updateMany({
      where: { executorId: input.executorId, requestedUntil: { lte: now }, screenCiphertext: { not: null } },
      data: { screenCiphertext: null, capturedAt: null },
    })
    for (const frame of input.frames) {
      await tx.executorHostSession.updateMany({
        where: {
          executorId: input.executorId, sessionId: frame.sessionId, ownerKey: frame.ownerKey,
          requestedUntil: { gt: now },
          OR: [{ capturedAt: null }, { capturedAt: { lt: new Date(input.observedAt) } }],
        },
        data: {
          capturedAt: new Date(input.observedAt),
          screenCiphertext: frame.screen ? encryptExecutorCommandJson(encryptionSecret, frame.screen) : null,
        },
      })
    }
    return { requests: await tx.executorHostSession.findMany({
      where: { executorId: input.executorId, requestedUntil: { gt: now } },
      select: { ownerKey: true, sessionId: true },
      orderBy: { requestedUntil: 'desc' }, take: 8,
    }) }
  }, now)
}

