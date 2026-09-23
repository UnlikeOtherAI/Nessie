import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { countRateLimitHit, rateLimitKeyHash } from '@nessie/db'
import {
  EXECUTOR_ATTACHMENT_RATE_BUCKET,
  EXECUTOR_ATTACHMENT_RATE_MAXIMUM,
  EXECUTOR_ATTACHMENT_RATE_WINDOW_MS,
} from '@nessie/executor-manage'
import { canonicalExecutorJson } from '@nessie/schemas'
import Fastify from 'fastify'

import { executorApi } from '../../executor/src/api-client.js'
import {
  deliverExecutorCommandAttachments,
  ExecutorAttachmentDeliveryDeferred,
} from '../../executor/src/command-attachments.js'
import { uploadExecutorCommandAttachment } from '../../executor/src/daemon.js'
import { signExecutorDaemonPayload } from '../../executor/src/daemon-signature.js'
import { executorMcpImageReferences, extractExecutorMcpImages } from '../../executor/src/mcp-images.js'
import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { registerExecutorDaemonRoutes } from '../src/routes/executor-daemon-routes.js'
import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
  digestOf,
  pngBytes,
  seedAttachmentWorld,
  type AttachmentWorld,
} from '../../packages/executor-manage/test/command-attachment-fixture.js'

/**
 * Both halves of a local program's screenshot over real HTTP: the daemon's own
 * extraction, upload client, delivery loop and receipt signing against the
 * control plane's routes and a real database. The real Kelpie answer from the
 * Windows probe goes in; a result Nessie takes comes out, referencing the file
 * it kept — or, when Nessie refuses the image, the placeholder the daemon
 * rewrote it to, and when Nessie only asks it to wait, a retry.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const kelpieResult = (): Record<string, unknown> => JSON.parse(readFileSync(
  new URL('../../executor/test/fixtures/kelpie-screenshot-result.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

const withDaemonAndApi = async (
  run: (input: { apiBaseUrl: string; world: AttachmentWorld }) => Promise<void>,
): Promise<void> => {
  const prisma = attachmentTestPrisma()
  const world = await seedAttachmentWorld(prisma)
  const app = Fastify({ logger: false })
  registerRawBodyJsonParser(app)
  registerExecutorDaemonRoutes(app, {
    authSecret: 'executor-command-attachment-daemon-test-secret',
    encryptionKeyRing: ATTACHMENT_SECRET,
    fileService: world.fileService,
    prisma,
  } as never)
  const apiBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    await run({ apiBaseUrl, world })
  } finally {
    await app.close()
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** One `mcp.call` result as the daemon holds it at `result_pending`, and its delivery. */
const deliverKelpie = async (apiBaseUrl: string, world: AttachmentWorld, commandId: string) => {
  const extracted = extractExecutorMcpImages(kelpieResult())
  const sidecars = new Map(extracted.images.map((image) => [image.digest, image.bytes]))
  const state = {
    apiBaseUrl, connectionEpoch: '1', executorId: world.executorId, machinePrivateKey: world.machinePrivateKey,
  }
  const journaled: Array<{ delivered: string[]; result: Record<string, unknown> }> = []
  const result = await deliverExecutorCommandAttachments({
    // A live command: a failure before its expiry is retried, not withdrawn.
    command: { commandId, expiresAt: new Date(Date.now() + 60_000).toISOString() } as never,
    journal: async (progress) => { journaled.push(progress) },
    result: { ...extracted.result, success: true },
    sidecars: { read: async (_commandId, imageDigest) => sidecars.get(imageDigest) ?? null },
    upload: uploadExecutorCommandAttachment(state as never),
  })
  return { extracted, journaled, result, state }
}

const sendReceipt = async (
  state: { apiBaseUrl: string; connectionEpoch: string; executorId: string; machinePrivateKey: string },
  commandId: string,
  result: Record<string, unknown>,
) => {
  const payload = {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    receipt: {
      commandId, occurredAt: new Date().toISOString(), resultDigest: digest(result), state: 'result_acknowledged' as const,
    },
  }
  return executorApi.recordCommandReceipt(state.apiBaseUrl, {
    ...payload,
    receipt: payload.receipt as never,
    result,
    signature: signExecutorDaemonPayload(state.machinePrivateKey, 'receipt', payload),
  })
}

dbTest('the daemon\'s own upload of Kelpie\'s screenshot is kept, and the result naming it is taken', async () => {
  await withDaemonAndApi(async ({ apiBaseUrl, world }) => {
    const commandId = await world.createCommand('started')
    const { extracted, journaled, result, state } = await deliverKelpie(apiBaseUrl, world, commandId)
    assert.equal(extracted.images.length, 1, 'Kelpie\'s three copies are one image')
    const [reference] = executorMcpImageReferences(result)
    assert.ok(reference)
    assert.deepEqual(journaled.map((progress) => progress.delivered), [[reference.attachmentDigest]], 'journaled as delivered')

    const kept = await world.prisma.attachment.findFirstOrThrow({ where: { executorCommandId: commandId } })
    assert.equal(kept.contentDigest, reference.attachmentDigest)
    assert.equal(kept.contentByteLength, 13_715)
    assert.equal(kept.filename, 'kelpie-screenshot-1.png')
    assert.equal(kept.uploaderId, world.holderId)

    assert.deepEqual(await sendReceipt(state, commandId, result), { recorded: true })
    const command = await world.prisma.executorCommand.findUniqueOrThrow({ where: { id: commandId } })
    assert.equal(command.state, 'result_acknowledged')
    assert.equal(command.resultDigest, digest(result))
  })
})

dbTest('an image Nessie refuses is rewritten to its placeholder, and that result is taken', async () => {
  await withDaemonAndApi(async ({ apiBaseUrl, world }) => {
    const commandId = await world.createCommand('started')
    // The command already holds its six.
    await world.prisma.attachment.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        contentByteLength: 100, contentDigest: `sha256:${String(index).padStart(64, '0')}`,
        executorCommandId: commandId, filename: `seeded-${index}.png`, kind: 'image', mime: 'image/png',
        organizationId: world.organizationId, sizeBytes: 100n, storageKey: `${world.organizationId}/seeded-${index}`,
        uploaderId: world.holderId,
      })),
    })
    const { journaled, result, state } = await deliverKelpie(apiBaseUrl, world, commandId)
    assert.equal(journaled.length, 1, 'the rewritten result is journaled before the receipt')
    assert.deepEqual(journaled[0]!.delivered, [])
    assert.deepEqual(journaled[0]!.result, result)
    assert.deepEqual(executorMcpImageReferences(result), [])
    assert.match(
      JSON.stringify(result),
      /\[image unavailable: Nessie refused it \(A command keeps at most 6 images\.\)\]/,
    )
    assert.deepEqual(await sendReceipt(state, commandId, result), { recorded: true })
  })
})

dbTest('Nessie asking the daemon to wait keeps the image for the next poll', async () => {
  await withDaemonAndApi(async ({ apiBaseUrl, world }) => {
    const keyHash = rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, world.executorId)
    const now = Date.now()
    for (let index = 0; index < EXECUTOR_ATTACHMENT_RATE_MAXIMUM; index += 1) {
      await countRateLimitHit(world.prisma, {
        bucket: EXECUTOR_ATTACHMENT_RATE_BUCKET,
        keyHash,
        nowMs: now,
        rule: { max: EXECUTOR_ATTACHMENT_RATE_MAXIMUM, windowMs: EXECUTOR_ATTACHMENT_RATE_WINDOW_MS },
      })
    }
    const commandId = await world.createCommand('started')
    await assert.rejects(
      deliverKelpie(apiBaseUrl, world, commandId),
      (error: unknown) => error instanceof ExecutorAttachmentDeliveryDeferred
        && (error.cause as { status?: number }).status === 429,
    )
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 0)
    // The next window.
    await world.prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key_hash" = ${keyHash}`
    const { result } = await deliverKelpie(apiBaseUrl, world, commandId)
    assert.equal(executorMcpImageReferences(result).length, 1)
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 1)
  })
})

dbTest('the receipt frees the images its result does not name', async () => {
  await withDaemonAndApi(async ({ apiBaseUrl, world }) => {
    const commandId = await world.createCommand('started')
    const named = pngBytes(1_200)
    const dropped = pngBytes(1_300)
    for (const bytes of [named, dropped]) {
      await executorApi.uploadCommandAttachment(apiBaseUrl, world.upload(commandId, bytes), { timeoutMs: 15_000 })
    }
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 2)
    // The daemon gave the second one up — say its upload outlived the command
    // while the server still went on to keep it.
    const result = {
      content: [
        { attachmentDigest: digestOf(named), byteLength: named.length, mimeType: 'image/png', type: 'image' },
        { text: '[image unavailable: it could not be delivered before its command expired]', type: 'text' },
      ],
      success: true,
    }
    const state = {
      apiBaseUrl, connectionEpoch: '1', executorId: world.executorId, machinePrivateKey: world.machinePrivateKey,
    }
    assert.deepEqual(await sendReceipt(state, commandId, result), { recorded: true })
    const kept = await world.prisma.attachment.findMany({ where: { executorCommandId: commandId } })
    assert.deepEqual(kept.map((row) => row.contentDigest), [digestOf(named)])
    // The daemon retrying the same receipt is taken as recorded, again.
    assert.deepEqual(await sendReceipt(state, commandId, result), { recorded: true })
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 1)
  })
})
