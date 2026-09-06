import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type { PushPayload, PushResult, PushTarget } from '@nessie/push'

import {
  handlePushDispatch,
  type PushDispatchPrisma,
  type PushSenders,
} from '../../src/control/push-dispatch.js'
import { runDatabaseTest } from './support.js'

// `push_deliveries` is an outcome log with no unique key, and the handler took
// no claim of its own, so a `push.dispatch` job that was redelivered — a
// dropped ack during a drain, a lock expiry, a nack-and-retry — sent the same
// notification a second time (horizontal-scaling audit 5.13). The guard is a
// `push_send_claims` row per (notification, endpoint), taken before the
// provider is called.
//
// This lives in `test/db/` because the guard IS a Postgres unique index: an
// in-memory fake would happily "win" both claims and prove nothing
// (docs/standards/testing.md). It drives no global poller, so it needs no
// `assertGlobalQueuesQuiet` — but `push_credentials.provider` is unique across
// the whole database, so the suite still needs a database it owns.

const AUTH_SECRET = 'push-idempotency-test-secret'

type Seed = {
  channelId: string
  messageId: string
  organizationId: string
  otherMessageId: string
  threadId: string
  tokenId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `push-claim ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'General',
      slug: `c-${randomUUID()}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const author = await prisma.user.create({
    data: { displayName: 'Author', email: `author-${randomUUID()}@example.test` },
  })
  const recipient = await prisma.user.create({
    data: { displayName: 'Recipient', email: `recipient-${randomUUID()}@example.test` },
  })
  for (const user of [author, recipient]) {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id },
    })
    await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  }
  const message = await prisma.message.create({
    data: { content: 'ping', role: 'user', threadId: thread.id, userId: author.id },
  })
  const otherMessage = await prisma.message.create({
    data: { content: 'pong', role: 'user', threadId: thread.id, userId: author.id },
  })
  const token = await prisma.deviceToken.create({
    data: {
      organizationId: organization.id,
      platform: 'ios',
      token: `device-${randomUUID()}`,
      userId: recipient.id,
    },
  })

  // APNs credentials are global (`push_credentials.provider` is unique), so the
  // suite writes them itself and removes them again in `cleanup`.
  const secretRef = `secret_push_apns_${randomUUID()}`
  const encrypted = encryptWithKey(deriveSecretKey(AUTH_SECRET), '-----P8-----')
  await prisma.mcpOAuthSecret.create({ data: { ref: secretRef, ...encrypted } })
  await prisma.pushCredential.create({
    data: {
      apnsKeyId: 'KEY123',
      apnsTeamId: 'TEAM123',
      apnsTopic: 'com.example.app',
      provider: 'apns',
      secretRef,
      updatedByUserId: author.id,
    },
  })

  return {
    channelId: channel.id,
    messageId: message.id,
    organizationId: organization.id,
    otherMessageId: otherMessage.id,
    threadId: thread.id,
    tokenId: token.id,
    userId: recipient.id,
  }
}

const cleanup = async (prisma: PrismaClient, state: Seed): Promise<void> => {
  await prisma.pushCredential.deleteMany({ where: { provider: 'apns' } })
  await prisma.mcpOAuthSecret.deleteMany({ where: { ref: { startsWith: 'secret_push_apns_' } } })
  await prisma.organization.delete({ where: { id: state.organizationId } })
}

type SendCall = { token: string; body: string | undefined }

const recordingSenders = (
  calls: SendCall[],
  result: PushResult = { ok: true, status: 200, deadToken: false },
): PushSenders => ({
  sendApns: async (_creds, target: PushTarget, payload: PushPayload) => {
    calls.push({ token: target.token, body: payload.body })
    return result
  },
  sendFcm: async () => ({ ok: false, status: 0, deadToken: false, error: 'unused' }),
})

const deps = (prisma: PrismaClient, senders: PushSenders): Parameters<
  typeof handlePushDispatch
>[0] => ({
  authSecret: AUTH_SECRET,
  prisma: prisma as unknown as PushDispatchPrisma,
  retryDelayMs: () => 0,
  senders,
})

const jobPayload = (state: Seed, messageId: string) => ({
  authorName: 'Author',
  channelId: state.channelId,
  contentSnippet: 'ping',
  mentionUserIds: [],
  messageId,
  organizationId: state.organizationId,
  threadId: state.threadId,
})

runDatabaseTest('a redelivered push.dispatch job sends once and logs one delivery', async () => {
  const prisma = new PrismaClient()
  const state = await seed(prisma)
  try {
    const calls: SendCall[] = []
    const senders = recordingSenders(calls)

    const first = await handlePushDispatch(deps(prisma, senders), jobPayload(state, state.messageId))
    // The queue redelivers the identical job: same row, same payload.
    const second = await handlePushDispatch(deps(prisma, senders), jobPayload(state, state.messageId))

    assert.equal(calls.length, 1, 'the provider is contacted exactly once')
    assert.equal(first.sent, 1)
    assert.equal(second.sent, 0, 'the redelivery sends nothing and does not fail')

    const deliveries = await prisma.pushDelivery.count({
      where: { messageId: state.messageId, organizationId: state.organizationId },
    })
    assert.equal(deliveries, 1, 'push_deliveries keeps exactly one outcome row')

    const claims = await prisma.pushSendClaim.count({
      where: {
        notificationKey: `push:message:${state.messageId}`,
        organizationId: state.organizationId,
      },
    })
    assert.equal(claims, 1, 'one endpoint, one claim')
  } finally {
    await cleanup(prisma, state)
    await prisma.$disconnect()
  }
})

runDatabaseTest('two workers racing the same job produce one send', async () => {
  const prisma = new PrismaClient()
  const state = await seed(prisma)
  try {
    const calls: SendCall[] = []
    const senders = recordingSenders(calls)

    // Both workers claimed the row before either acked — a lock lapse, or the
    // same job handed out twice. They must not both ring the device.
    const [left, right] = await Promise.all([
      handlePushDispatch(deps(prisma, senders), jobPayload(state, state.messageId)),
      handlePushDispatch(deps(prisma, senders), jobPayload(state, state.messageId)),
    ])

    assert.equal(calls.length, 1, 'only the winner of the claim contacts the provider')
    assert.equal(left.sent + right.sent, 1, 'exactly one of the two racers sends')
  } finally {
    await cleanup(prisma, state)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a different notification to the same device still sends', async () => {
  const prisma = new PrismaClient()
  const state = await seed(prisma)
  try {
    const calls: SendCall[] = []
    const senders = recordingSenders(calls)

    await handlePushDispatch(deps(prisma, senders), jobPayload(state, state.messageId))
    const second = await handlePushDispatch(
      deps(prisma, senders),
      jobPayload(state, state.otherMessageId),
    )

    assert.equal(calls.length, 2, 'a second message is a second notification')
    assert.equal(second.sent, 1)

    const claims = await prisma.pushSendClaim.count({
      where: { organizationId: state.organizationId },
    })
    assert.equal(claims, 2, 'one claim per notification, not one per device')
  } finally {
    await cleanup(prisma, state)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a dead token is still pruned through the claimed path', async () => {
  const prisma = new PrismaClient()
  const state = await seed(prisma)
  try {
    const calls: SendCall[] = []
    const senders = recordingSenders(calls, {
      ok: false,
      status: 410,
      deadToken: true,
      error: 'BadDeviceToken',
    })

    const summary = await handlePushDispatch(
      deps(prisma, senders),
      jobPayload(state, state.messageId),
    )

    assert.equal(summary.pruned, 1, 'the dead device row is removed')
    const remaining = await prisma.deviceToken.count({ where: { id: state.tokenId } })
    assert.equal(remaining, 0)

    const delivery = await prisma.pushDelivery.findFirst({
      where: { messageId: state.messageId, organizationId: state.organizationId },
    })
    assert.equal(delivery?.status, 'dead', 'the log still records the outcome')
    assert.equal(delivery?.errorCode, 'BadDeviceToken', 'and the provider error code')
  } finally {
    await cleanup(prisma, state)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a retry after a successful send does not re-send', async () => {
  const prisma = new PrismaClient()
  const state = await seed(prisma)
  try {
    const calls: SendCall[] = []
    // The first attempt succeeds. The second is the queue's own retry arm —
    // a nack-and-retry of the very same job after the ack was lost. It must
    // reach no provider, and it must not fail: a transient 5xx from the
    // retrying sender would surface as a failure if the send were re-attempted.
    const succeeding = recordingSenders(calls)
    await handlePushDispatch(deps(prisma, succeeding), jobPayload(state, state.messageId))

    const retrying = recordingSenders(calls, {
      ok: false,
      status: 503,
      deadToken: false,
      error: 'ServiceUnavailable',
    })
    const retry = await handlePushDispatch(deps(prisma, retrying), jobPayload(state, state.messageId))

    assert.equal(calls.length, 1, 'the retry contacts no provider at all')
    assert.deepEqual(retry, { sent: 0, failed: 0, pruned: 0 }, 'a lost claim is not a failure')

    const deliveries = await prisma.pushDelivery.findMany({
      where: { messageId: state.messageId, organizationId: state.organizationId },
    })
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0]?.status, 'sent')
  } finally {
    await cleanup(prisma, state)
    await prisma.$disconnect()
  }
})
