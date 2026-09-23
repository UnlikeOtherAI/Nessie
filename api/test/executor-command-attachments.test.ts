import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { loadConfig } from '@nessie/config'
import { countRateLimitHit, rateLimitKeyHash } from '@nessie/db'
import {
  EXECUTOR_ATTACHMENT_RATE_BUCKET,
  EXECUTOR_ATTACHMENT_RATE_MAXIMUM,
  EXECUTOR_ATTACHMENT_RATE_WINDOW_MS,
} from '@nessie/executor-manage'
import { EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { rateLimitFor, resolveGlobalRateLimitBucket } from '../src/routes/auth-rate-limit.js'
import { registerExecutorDaemonRoutes } from '../src/routes/executor-daemon-routes.js'
import { registerCreateThreadMessageRoute } from '../src/routes/thread-message-create.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'
import { createFeedback, FeedbackServiceError } from '../src/services/feedback.js'
import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
  kelpieScreenshot,
  pngBytes,
  seedAttachmentWorld,
  type AttachmentWorld,
} from '../../packages/executor-manage/test/command-attachment-fixture.js'

/**
 * The daemon's image upload route and the screenshots it keeps, served by the
 * ordinary attachment routes (docs/plans/2026-09-22-executor-local-apps/
 * screenshots.md §2), against a real database: the raised body limit, the
 * statuses a daemon tells refusals from retries by, who may read a run's
 * screenshot with and without a disclosure basis, and that a screenshot can
 * never be passed off as a person's pending upload.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Harness = {
  app: ReturnType<typeof Fastify>
  as: (userId: string) => void
  world: AttachmentWorld
}

const withApp = async (
  options: { channelVisibility?: 'private' | 'public' },
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const prisma = attachmentTestPrisma()
  const world = await seedAttachmentWorld(prisma, options)
  let viewerId = world.holderId
  const app = Fastify({ logger: false })
  registerRawBodyJsonParser(app)
  const deps = {
    authSecret: 'executor-command-attachment-route-test-secret',
    buildChannelRealtimeScopes: () => [],
    encryptionKeyRing: ATTACHMENT_SECRET,
    fileService: world.fileService,
    isPersonalAssistantChannelType: () => false,
    messageMemoryCaptureConfig: null,
    prisma,
    realtimeHub: { publishWs: async () => undefined },
    requireActorContext: () => ({
      actor: { actorType: 'user', actorId: viewerId, roles: ['member'] },
      actionContext: { requestId: randomUUID() },
      tenant: { organizationId: world.organizationId },
    }),
  }
  registerExecutorDaemonRoutes(app, deps as never)
  registerUploadRoutes(app, deps as never)
  registerCreateThreadMessageRoute(app, deps as never)
  await app.ready()
  try {
    await run({ app, as: (userId) => { viewerId = userId }, world })
  } finally {
    await app.close()
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

const postUpload = (app: Harness['app'], payload: unknown) => app.inject({
  method: 'POST',
  url: '/api/executor-daemon/commands/attachment',
  payload: payload as Record<string, unknown>,
})

/** A screenshot the daemon uploaded for a fresh command of the world's run. */
const uploadedScreenshot = async ({ app, world }: Harness): Promise<string> => {
  const commandId = await world.createCommand('started')
  const response = await postUpload(app, world.upload(commandId, kelpieScreenshot()))
  assert.equal(response.statusCode, 200, response.body)
  const row = await world.prisma.attachment.findFirstOrThrow({ where: { executorCommandId: commandId } })
  return row.id
}

const readAs = async (harness: Harness, userId: string, attachmentId: string, thumbnail = false) => {
  harness.as(userId)
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/attachments/${attachmentId}${thumbnail ? '/thumbnail' : ''}`,
  })
  return response.statusCode
}

dbTest('the upload route takes a screenshot past the global body limit, once', async () => {
  await withApp({}, async ({ app, world }) => {
    const commandId = await world.createCommand('started')
    // 2 MiB decoded is 2.7 MB of base64: over Fastify's 1 MiB default.
    const bytes = pngBytes(2 * 1024 * 1024)
    const first = await postUpload(app, world.upload(commandId, bytes))
    assert.equal(first.statusCode, 200, first.body)
    assert.deepEqual(first.json(), { data: { recorded: true } })
    const again = await postUpload(app, world.upload(commandId, bytes))
    assert.equal(again.statusCode, 200, again.body)
    const rows = await world.prisma.attachment.findMany({ where: { executorCommandId: commandId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.contentByteLength, bytes.length)
    // Undecodable pixels have no inline preview, so the worker is asked for one.
    assert.equal(rows[0]!.thumbnailStatus, 'pending')
    assert.equal(await world.prisma.queueJob.count({ where: { idempotencyKey: `thumb:${rows[0]!.id}` } }), 1)
    await world.prisma.queueJob.deleteMany({ where: { idempotencyKey: `thumb:${rows[0]!.id}` } })

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/executor-daemon/commands/attachment',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ dataBase64: 'A'.repeat(EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH + 32 * 1024) }),
    })
    assert.equal(oversized.statusCode, 413)
  })
})

dbTest('a daemon can tell a refusal from a reason to wait by the status alone', async () => {
  await withApp({}, async ({ app, world }) => {
    const started = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    const altered = await postUpload(app, { ...world.upload(started, screenshot), dataBase64: pngBytes(13_715).toString('base64') })
    assert.equal(altered.statusCode, 400)
    assert.equal(altered.json().error.code, 'EXECUTOR_COMMAND_ATTACHMENT_INVALID')

    const leased = await world.createCommand('leased')
    const early = await postUpload(app, world.upload(leased, screenshot))
    assert.equal(early.statusCode, 409)
    assert.equal(early.json().error.code, 'EXECUTOR_COMMAND_ATTACHMENT_REFUSED')

    const unknown = await postUpload(app, world.upload(randomUUID(), screenshot))
    assert.equal(unknown.statusCode, 404)

    const now = Date.now()
    // This window and the next, so a minute boundary passing mid-test cannot
    // hand the upload below a fresh one.
    for (let index = 0; index < 2 * EXECUTOR_ATTACHMENT_RATE_MAXIMUM; index += 1) {
      await countRateLimitHit(world.prisma, {
        bucket: EXECUTOR_ATTACHMENT_RATE_BUCKET,
        keyHash: rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, world.executorId),
        nowMs: now + (index < EXECUTOR_ATTACHMENT_RATE_MAXIMUM ? 0 : EXECUTOR_ATTACHMENT_RATE_WINDOW_MS),
        rule: { max: EXECUTOR_ATTACHMENT_RATE_MAXIMUM, windowMs: EXECUTOR_ATTACHMENT_RATE_WINDOW_MS },
      })
    }
    // 429 is the one answer the daemon keeps the image for and retries.
    const busy = await postUpload(app, world.upload(started, screenshot))
    assert.equal(busy.statusCode, 429)
    assert.equal(busy.json().error.code, 'EXECUTOR_COMMAND_ATTACHMENT_RATE_LIMITED')
    assert.equal(busy.headers['retry-after'], '60')
  })
})

dbTest('an unsigned upload is answered without a byte reaching storage', async () => {
  await withApp({}, async ({ app, world }) => {
    const commandId = await world.createCommand('started')
    const forged = { ...world.upload(commandId, pngBytes(2 * 1024 * 1024)), signature: 'A'.repeat(86) }
    const refused = await postUpload(app, forged)
    assert.equal(refused.statusCode, 401)
    assert.equal(refused.json().error.code, 'EXECUTOR_DAEMON_PROOF_INVALID')
    // Past the raised limit, the body is not even read.
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/executor-daemon/commands/attachment',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...forged, dataBase64: 'A'.repeat(EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH + 32 * 1024) }),
    })
    assert.equal(oversized.statusCode, 413)
    assert.equal(await world.prisma.attachment.count({ where: { organizationId: world.organizationId } }), 0)
    assert.equal(await world.prisma.storageUsageEvent.count({ where: { organizationId: world.organizationId } }), 0)
  })
})

test('the upload route has its own per-IP bucket, sized to real traffic, before its body is read', () => {
  const bucket = resolveGlobalRateLimitBucket({
    isPublic: true, method: 'POST', routePath: '/api/executor-daemon/commands/attachment',
  })
  assert.equal(bucket, 'executorAttachmentIp')
  const { bucket: storeKey, rule } = rateLimitFor(loadConfig({ argv: [], env: {} }), 'executorAttachmentIp')
  assert.equal(storeKey, 'executor.attachment.ip')
  assert.deepEqual(rule, { max: 2 * EXECUTOR_ATTACHMENT_RATE_MAXIMUM, windowMs: 60_000 })
  // The other daemon routes keep the session floor.
  assert.equal(resolveGlobalRateLimitBucket({
    isPublic: true, method: 'POST', routePath: '/api/executor-daemon/commands/receipt',
  }), 'executorDaemonSessionIp')
})

dbTest('a run\'s screenshot is served to the people in its conversation and to nobody else', async () => {
  await withApp({ channelVisibility: 'private' }, async (harness) => {
    const { world } = harness
    const attachmentId = await uploadedScreenshot(harness)
    assert.equal(await readAs(harness, world.holderId, attachmentId), 200)
    assert.equal(await readAs(harness, world.holderId, attachmentId, true), 200)
    assert.equal(await readAs(harness, world.colleagueId, attachmentId), 200)
    assert.equal(await readAs(harness, world.outsiderId, attachmentId), 404)
    assert.equal(await readAs(harness, world.outsiderId, attachmentId, true), 404)
  })
})

dbTest('the run\'s disclosure basis withholds its screenshot even from a member of the room', async () => {
  await withApp({ channelVisibility: 'private' }, async (harness) => {
    const { world } = harness
    const attachmentId = await uploadedScreenshot(harness)
    // The run read something only its launching person may see.
    await world.prisma.runBasisScope.create({
      data: { organizationId: world.organizationId, runId: world.runId, scopeId: world.holderId, scopeType: 'user' },
    })
    assert.equal(await readAs(harness, world.colleagueId, attachmentId), 404)
    assert.equal(await readAs(harness, world.colleagueId, attachmentId, true), 404)
    assert.equal(await readAs(harness, world.holderId, attachmentId), 200)
  })
})

dbTest('in a public room the screenshot is the room\'s audience\'s, like the reply built on it', async () => {
  await withApp({ channelVisibility: 'public' }, async (harness) => {
    const { world } = harness
    const attachmentId = await uploadedScreenshot(harness)
    assert.equal(await readAs(harness, world.outsiderId, attachmentId), 200)
    // Deleting the room closes it, as it closes the room's history.
    await world.prisma.channel.update({ where: { id: world.channelId }, data: { deletedAt: new Date() } })
    assert.equal(await readAs(harness, world.outsiderId, attachmentId), 404)
    assert.equal(await readAs(harness, world.holderId, attachmentId), 404)
  })
})

dbTest('a screenshot is never re-linked to a message nor discarded as a pending upload', async () => {
  await withApp({ channelVisibility: 'private' }, async (harness) => {
    const { app, world } = harness
    const attachmentId = await uploadedScreenshot(harness)
    harness.as(world.holderId)
    const posted = await app.inject({
      method: 'POST',
      url: `/api/threads/${world.threadId}/messages`,
      payload: { attachmentIds: [attachmentId], content: 'Look at this' },
    })
    assert.equal(posted.statusCode, 201, posted.body)
    const deleted = await app.inject({ method: 'DELETE', url: `/api/attachments/${attachmentId}` })
    assert.equal(deleted.statusCode, 404)
    const row = await world.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })
    assert.equal(row.messageId, null)
    const messages = await world.prisma.message.findMany({ where: { threadId: world.threadId }, select: { id: true } })
    await world.prisma.queueJob.deleteMany({
      where: { idempotencyKey: { in: messages.map((message) => `push:${message.id}`) } },
    })
    await world.prisma.message.deleteMany({ where: { threadId: world.threadId } })
  })
})

dbTest('a screenshot is not feedback its launching person can file, though they uploaded it', async () => {
  await withApp({ channelVisibility: 'private' }, async (harness) => {
    const { world } = harness
    const attachmentId = await uploadedScreenshot(harness)
    await assert.rejects(
      createFeedback(world.prisma, loadConfig({ argv: [], env: {} }), {
        organizationId: world.organizationId, userId: world.holderId,
      }, { attachmentId, body: 'The page looks wrong', title: 'Screenshot' }),
      (error: unknown) => error instanceof FeedbackServiceError && error.code === 'INVALID_ATTACHMENT',
    )
    assert.equal(await world.prisma.feedback.count({ where: { organizationId: world.organizationId } }), 0)
  })
})
