import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { canonicalExecutorJson } from '@nessie/schemas'
import Fastify from 'fastify'

import { executorApi } from '../../executor/src/api-client.js'
import { deliverExecutorCommandAttachments } from '../../executor/src/command-attachments.js'
import { uploadExecutorCommandAttachment } from '../../executor/src/daemon.js'
import { signExecutorDaemonPayload } from '../../executor/src/daemon-signature.js'
import { executorMcpImageReferences, extractExecutorMcpImages } from '../../executor/src/mcp-images.js'
import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { registerExecutorDaemonRoutes } from '../src/routes/executor-daemon-routes.js'
import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
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
  const journaled: Record<string, unknown>[] = []
  const result = await deliverExecutorCommandAttachments({
    command: { commandId } as never,
    journal: async (rewritten) => { journaled.push(rewritten) },
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
    assert.equal(journaled.length, 0, 'nothing was withdrawn')
    const [reference] = executorMcpImageReferences(result)
    assert.ok(reference)

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
    const busy = await world.createCommand('started')
    await world.prisma.attachment.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({
        contentByteLength: 100, contentDigest: `sha256:${String(index).padStart(64, '0')}`,
        executorCommandId: busy, filename: `seeded-${index}.png`, kind: 'image', mime: 'image/png',
        organizationId: world.organizationId, sizeBytes: 100n, storageKey: `${world.organizationId}/seeded-${index}`,
        uploaderId: world.holderId,
      })),
    })
    const commandId = await world.createCommand('started')
    await assert.rejects(
      deliverKelpie(apiBaseUrl, world, commandId),
      (error: unknown) => (error as { status?: number }).status === 429,
    )
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 0)
    await world.prisma.attachment.updateMany({
      where: { executorCommandId: busy }, data: { createdAt: new Date(Date.now() - 3_600_000) },
    })
    const { journaled } = await deliverKelpie(apiBaseUrl, world, commandId)
    assert.equal(journaled.length, 0)
    assert.equal(await world.prisma.attachment.count({ where: { executorCommandId: commandId } }), 1)
  })
})
