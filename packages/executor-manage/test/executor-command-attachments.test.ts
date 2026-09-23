import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { ExecutorCommandReceiptState } from '@prisma/client'
import { countRateLimitHit, rateLimitKeyHash } from '@nessie/db'
import type { FileService } from '@nessie/runtime'
import { EXECUTOR_RESULT_IMAGE_MAX_BYTES } from '@nessie/schemas'

import {
  authorizeExecutorDaemonControlCall,
  deleteExecutorCommandAttachments,
  EXECUTOR_ATTACHMENT_RATE_BUCKET,
  EXECUTOR_ATTACHMENT_RATE_MAXIMUM,
  EXECUTOR_ATTACHMENT_RATE_WINDOW_MS,
  ExecutorError,
  recordAuthorizedExecutorCommandAttachment,
  recordExecutorCommandReceipt,
  releaseUnreferencedExecutorCommandAttachments,
} from '../src/index.js'
import { executorCommandDigest } from '../src/executor-command-codec.js'
import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
  digestOf,
  kelpieScreenshot,
  pngBytes,
  seedAttachmentWorld,
  type AttachmentWorld,
} from './command-attachment-fixture.js'

/**
 * The control-plane half of a local program's images
 * (docs/plans/2026-09-22-executor-local-apps/screenshots.md §2), against a real
 * database and a real filesystem-backed FileService: which commands take an
 * image, what is checked before a byte is kept, the caps and the rate, the
 * attachment and the accounting rows it writes, and the result intake that
 * only accepts references to what was kept.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const withWorld = async (run: (world: AttachmentWorld) => Promise<void>): Promise<void> => {
  const prisma = attachmentTestPrisma()
  const world = await seedAttachmentWorld(prisma)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

const record = (
  world: AttachmentWorld,
  input: ReturnType<AttachmentWorld['upload']>,
  fileService?: FileService,
  now?: Date,
) =>
  recordAuthorizedExecutorCommandAttachment(world.prisma, {
    encryptionSecret: ATTACHMENT_SECRET,
    fileService: fileService ?? world.fileService,
  }, input, now)

const refusedWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof ExecutorError, String(error))
  assert.equal(error.code, code, error.message)
  return true
}

const imagesOf = (world: AttachmentWorld, commandId: string) =>
  world.prisma.attachment.findMany({ where: { executorCommandId: commandId }, orderBy: { createdAt: 'asc' } })

dbTest('an image is kept in each state its command can still deliver a result, as the launching person\'s file', async () => {
  await withWorld(async (world) => {
    const screenshot = kelpieScreenshot()
    assert.equal(screenshot.length, 13_715)
    for (const state of ['accepted', 'started', 'unknown_outcome'] as const) {
      const commandId = await world.createCommand(state)
      const stored = await record(world, world.upload(commandId, screenshot))
      assert.ok(stored, `a ${state} command keeps the image`)
      const [row] = await imagesOf(world, commandId)
      assert.ok(row)
      assert.equal(row.id, stored.id)
      assert.equal(row.organizationId, world.organizationId)
      assert.equal(row.uploaderId, world.holderId, 'the person whose launch the command runs under')
      assert.equal(row.kind, 'image')
      assert.equal(row.mime, 'image/png')
      assert.equal(row.filename, 'kelpie-screenshot-1.png')
      assert.equal(row.contentDigest, digestOf(screenshot))
      assert.equal(row.contentByteLength, 13_715)
      assert.equal(row.messageId, null)
      // The ordinary image path: metadata stripped (re-encoded) and an inline preview.
      assert.ok(row.thumbnailKey, 'a thumbnail is stored beside it')
      assert.equal(row.thumbnailStatus, 'ready')
      const bytes = await world.fileService.openStream(row.id, world.organizationId)
      assert.ok(bytes, 'the bytes are readable through the FileService')
      bytes.stream.destroy()

      const events = await world.prisma.storageUsageEvent.findMany({
        where: { attachmentId: row.id }, orderBy: { operation: 'asc' },
      })
      assert.deepEqual(events.map((event) => event.operation), ['store', 'store.thumbnail'])
      const store = events[0]!
      assert.equal(store.deltaBytes, row.sizeBytes)
      assert.equal(store.organizationId, world.organizationId)
      assert.equal(store.uploaderId, world.holderId, 'usage lands on the launching person')
      assert.equal(store.actorId, world.agentId)
      assert.equal(store.actorType, 'agent')
      assert.equal(events[1]!.deltaBytes, row.thumbnailSizeBytes)
    }
  })
})

dbTest('the file is named after the program that answered, and counted within its command', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started', 'browser-two')
    await record(world, world.upload(commandId, pngBytes(2_000)))
    await record(world, world.upload(commandId, pngBytes(2_000)))
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pngBytes(996).subarray(8)])
    await record(world, world.upload(commandId, jpeg, { mimeType: 'image/jpeg' }))
    assert.deepEqual(
      (await imagesOf(world, commandId)).map((row) => row.filename),
      ['browser-two-screenshot-1.png', 'browser-two-screenshot-2.png', 'browser-two-screenshot-3.jpg'],
    )
  })
})

dbTest('a command that is not yet accepted, or already has its result, takes no new image', async () => {
  await withWorld(async (world) => {
    for (const state of ['leased', 'result_acknowledged'] as ExecutorCommandReceiptState[]) {
      const commandId = await world.createCommand(state)
      await assert.rejects(
        record(world, world.upload(commandId, pngBytes(500))),
        refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED'),
      )
      assert.equal((await imagesOf(world, commandId)).length, 0)
    }
    assert.equal(await world.prisma.storageUsageEvent.count({ where: { organizationId: world.organizationId } }), 0)
  })
})

dbTest('uploading the same image again is the same attachment, even once the result is in', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    const first = await record(world, world.upload(commandId, screenshot))
    assert.ok(first)
    // A daemon restart between the upload and the receipt uploads again.
    assert.equal(await record(world, world.upload(commandId, screenshot)), null)
    await world.prisma.executorCommand.update({ where: { id: commandId }, data: { state: 'result_acknowledged' } })
    // And a crash after the receipt but before the journal cleared, once more.
    assert.equal(await record(world, world.upload(commandId, screenshot)), null)
    assert.equal((await imagesOf(world, commandId)).length, 1)
    assert.equal(await world.prisma.storageUsageEvent.count({
      where: { attachmentId: first.id, operation: 'store' },
    }), 1)
  })
})

dbTest('bytes that are not their signed digest, or not the type they declare, are never kept', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    await assert.rejects(
      record(world, world.upload(commandId, screenshot, { digest: digestOf(pngBytes(100)) })),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_INVALID'),
    )
    // A PNG declared as a JPEG, signed and digested honestly.
    await assert.rejects(
      record(world, world.upload(commandId, screenshot, { mimeType: 'image/jpeg' })),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_INVALID'),
    )
    // Something that only calls itself an image.
    await assert.rejects(
      record(world, world.upload(commandId, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.repeat(4)))),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_INVALID'),
    )
    assert.equal((await imagesOf(world, commandId)).length, 0)
  })
})

dbTest('only this executor\'s own command, under its own signed domain, is answered', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    await assert.rejects(
      record(world, world.upload(commandId, screenshot, { domain: 'receipt' })),
      refusedWith('EXECUTOR_DAEMON_PROOF_INVALID'),
    )
    await assert.rejects(
      record(world, world.upload(randomUUID(), screenshot)),
      refusedWith('EXECUTOR_NOT_FOUND'),
    )
    // Another paired executor of the organisation cannot upload for this one's command.
    const other = await seedAttachmentWorld(world.prisma)
    try {
      await assert.rejects(
        record(other, other.upload(commandId, screenshot)),
        refusedWith('EXECUTOR_NOT_FOUND'),
      )
    } finally {
      await other.cleanup()
    }
    assert.equal((await imagesOf(world, commandId)).length, 0)
  })
})

dbTest('a command keeps at most six images and 8 MiB of them', async () => {
  await withWorld(async (world) => {
    const many = await world.createCommand('started')
    for (let index = 0; index < 6; index += 1) {
      assert.ok(await record(world, world.upload(many, pngBytes(1_000))))
    }
    await assert.rejects(
      record(world, world.upload(many, pngBytes(1_000))),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED'),
    )
    assert.equal((await imagesOf(world, many)).length, 6)

    const large = await world.createCommand('started')
    assert.ok(await record(world, world.upload(large, pngBytes(EXECUTOR_RESULT_IMAGE_MAX_BYTES))))
    assert.ok(await record(world, world.upload(large, pngBytes(EXECUTOR_RESULT_IMAGE_MAX_BYTES))))
    await assert.rejects(
      record(world, world.upload(large, pngBytes(100))),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED'),
    )
    assert.equal((await imagesOf(world, large)).length, 2)
  })
})

dbTest('uploads that race still keep at most six, and one image racing itself is kept once', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const outcomes = await Promise.allSettled(
      Array.from({ length: 9 }, () => record(world, world.upload(commandId, pngBytes(1_000)))),
    )
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 6)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED')(outcome.reason)
    }
    assert.equal((await imagesOf(world, commandId)).length, 6)

    const same = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    const racing = await Promise.all(
      Array.from({ length: 4 }, () => record(world, world.upload(same, screenshot))),
    )
    assert.equal(racing.filter((stored) => stored !== null).length, 1, 'one of them stored it')
    assert.equal((await imagesOf(world, same)).length, 1)
    // The losers wrote nothing that stays: one store event, for the one row.
    const [kept] = await imagesOf(world, same)
    assert.equal(await world.prisma.storageUsageEvent.count({
      where: { organizationId: world.organizationId, operation: 'store', attachmentId: kept!.id },
    }), 1)
  })
})

/**
 * Spends `count` of the executor's upload attempts in the window `now` falls
 * in. The rate tests hold one clock throughout, so a minute boundary passing
 * mid-test cannot reset the window under them.
 */
const spendAttempts = async (world: AttachmentWorld, count: number, now: Date): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await countRateLimitHit(world.prisma, {
      bucket: EXECUTOR_ATTACHMENT_RATE_BUCKET,
      keyHash: rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, world.executorId),
      nowMs: now.getTime(),
      rule: { max: EXECUTOR_ATTACHMENT_RATE_MAXIMUM, windowMs: EXECUTOR_ATTACHMENT_RATE_WINDOW_MS },
    })
  }
}

const resetAttempts = (world: AttachmentWorld) => world.prisma.$executeRaw`
  DELETE FROM "rate_limit_buckets"
  WHERE "key_hash" = ${rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, world.executorId)}
`

dbTest('an executor over its attempt rate is told to wait, not refused', async () => {
  await withWorld(async (world) => {
    const now = new Date()
    await spendAttempts(world, EXECUTOR_ATTACHMENT_RATE_MAXIMUM, now)
    const commandId = await world.createCommand('started')
    await assert.rejects(
      record(world, world.upload(commandId, pngBytes(500)), undefined, now),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_RATE_LIMITED'),
    )
    assert.equal((await imagesOf(world, commandId)).length, 0)
    // The next window takes it.
    await resetAttempts(world)
    assert.ok(await record(world, world.upload(commandId, pngBytes(500)), undefined, now))
  })
})

dbTest('a repeat of an image already kept still spends the executor\'s rate', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    const now = new Date()
    assert.ok(await record(world, world.upload(commandId, screenshot), undefined, now))
    // A daemon re-sending a kept image in a loop costs Nessie a parsed body
    // and a locked transaction each time, though nothing new is stored.
    await spendAttempts(world, EXECUTOR_ATTACHMENT_RATE_MAXIMUM - 2, now)
    assert.equal(await record(world, world.upload(commandId, screenshot), undefined, now), null, 'the window\'s last attempt')
    await assert.rejects(
      record(world, world.upload(commandId, screenshot), undefined, now),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_RATE_LIMITED'),
    )
  })
})

dbTest('an unsigned upload is refused before its bytes are read, and spends no executor\'s rate', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    // Signed under the wrong domain AND carrying bytes that are not their
    // digest: the signature answers first.
    await assert.rejects(
      record(world, world.upload(commandId, kelpieScreenshot(), { digest: digestOf(pngBytes(100)), domain: 'receipt' })),
      refusedWith('EXECUTOR_DAEMON_PROOF_INVALID'),
    )
    const [counter] = await world.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT "count" FROM "rate_limit_buckets"
      WHERE "key_hash" = ${rateLimitKeyHash(EXECUTOR_ATTACHMENT_RATE_BUCKET, world.executorId)}
    `
    assert.equal(counter, undefined, 'nobody without the machine key can spend its rate')
  })
})

dbTest('only a local program\'s call takes images', async () => {
  await withWorld(async (world) => {
    for (const operationKey of ['browser.observe', 'command.run']) {
      const commandId = await world.createCommand('started', 'kelpie', operationKey)
      await assert.rejects(
        record(world, world.upload(commandId, kelpieScreenshot())),
        refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED'),
      )
      assert.equal((await imagesOf(world, commandId)).length, 0)
    }
    assert.equal(await world.prisma.storageUsageEvent.count({ where: { organizationId: world.organizationId } }), 0)
  })
})

dbTest('a full storage quota refuses the image, with no row and no usage written', async () => {
  await withWorld(async (world) => {
    await world.prisma.budget.create({
      data: {
        mode: 'off', organizationId: world.organizationId, scopeId: world.organizationId,
        scopeType: 'organization', storageLimitBytes: 1_000n,
      },
    })
    const commandId = await world.createCommand('started')
    await assert.rejects(
      record(world, world.upload(commandId, kelpieScreenshot())),
      (error: unknown) => {
        refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED')(error)
        assert.match((error as Error).message, /file storage is full/)
        return true
      },
    )
    assert.equal((await imagesOf(world, commandId)).length, 0)
    assert.equal(await world.prisma.storageUsageEvent.count({ where: { organizationId: world.organizationId } }), 0)
  })
})

dbTest('a receipt that lands while the bytes are written leaves no image behind it', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    let entered!: () => void
    const storeEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const slowFiles: FileService = {
      ...world.fileService,
      store: async (input) => {
        entered()
        await released
        return world.fileService.store(input)
      },
    }
    const uploading = record(world, world.upload(commandId, kelpieScreenshot()), slowFiles)
    await storeEntered
    // The daemon gave the image up (its upload outlived the command) and
    // reported the result without it.
    const result = { content: [{ text: '[image unavailable: it could not be delivered before its command expired]', type: 'text' }], success: true }
    await recordExecutorCommandReceipt(world.prisma, ATTACHMENT_SECRET, world.executorId, {
      commandId, occurredAt: new Date().toISOString(), resultDigest: executorCommandDigest(result),
      state: 'result_acknowledged',
    }, result)
    release()
    await assert.rejects(uploading, refusedWith('EXECUTOR_COMMAND_ATTACHMENT_REFUSED'))
    assert.equal((await imagesOf(world, commandId)).length, 0)
    assert.equal(await world.prisma.storageUsageEvent.count({ where: { organizationId: world.organizationId } }), 0)
  })
})

dbTest('after intake, the images a result does not name are freed through the FileService', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const named = pngBytes(1_500)
    const dropped = pngBytes(1_700)
    await record(world, world.upload(commandId, named))
    const unnamed = await record(world, world.upload(commandId, dropped))
    assert.ok(unnamed)
    const result = {
      content: [{ attachmentDigest: digestOf(named), byteLength: named.length, mimeType: 'image/png', type: 'image' }],
      success: true,
    }
    await recordExecutorCommandReceipt(world.prisma, ATTACHMENT_SECRET, world.executorId, {
      commandId, occurredAt: new Date().toISOString(), resultDigest: executorCommandDigest(result),
      state: 'result_acknowledged',
    }, result)

    const release = () => releaseUnreferencedExecutorCommandAttachments(
      world.prisma, world.fileService, commandId, result,
    )
    assert.equal(await release(), 1)
    assert.deepEqual((await imagesOf(world, commandId)).map((row) => row.contentDigest), [digestOf(named)])
    // Its bytes, its thumbnail and their accounting net out.
    assert.equal(await world.fileService.openStream(unnamed.id, world.organizationId), null)
    const usage = await world.prisma.storageUsageEvent.findMany({ where: { attachmentId: unnamed.id } })
    assert.equal(usage.reduce((sum, event) => sum + event.deltaBytes, 0n), 0n)
    assert.ok(usage.some((event) => event.operation === 'delete'))
    // Again is nothing more.
    assert.equal(await release(), 0)

    // The retention hook: without `keep`, every image of the command goes.
    assert.equal(await deleteExecutorCommandAttachments(world.prisma, world.fileService, commandId), 1)
    assert.equal((await imagesOf(world, commandId)).length, 0)
    const all = await world.prisma.storageUsageEvent.findMany({ where: { organizationId: world.organizationId } })
    assert.equal(all.reduce((sum, event) => sum + event.deltaBytes, 0n), 0n, 'the organisation\'s usage is back to nothing')
  })
})

dbTest('the executor lock is free while the bytes are written', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    let entered!: () => void
    const storeEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const slowFiles: FileService = {
      ...world.fileService,
      store: async (input) => {
        entered()
        await released
        return world.fileService.store(input)
      },
    }
    const uploading = record(world, world.upload(commandId, kelpieScreenshot()), slowFiles)
    await storeEntered
    // A poll takes the same executor lock the upload's authorization took.
    const poll = world.signedPoll()
    assert.equal(
      await authorizeExecutorDaemonControlCall(world.prisma, poll, async () => 'polled'),
      'polled',
    )
    release()
    assert.ok(await uploading)
  })
})

dbTest('a result may reference only the images uploaded for its own command', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const screenshot = kelpieScreenshot()
    const reference = {
      attachmentDigest: digestOf(screenshot), byteLength: screenshot.length, mimeType: 'image/png', type: 'image',
    }
    const resultWith = (item: Record<string, unknown>) => ({
      content: [{ text: 'Captured example.com', type: 'text' }, item],
      success: true,
    })
    const receipt = (result: Record<string, unknown>) => recordExecutorCommandReceipt(
      world.prisma,
      ATTACHMENT_SECRET,
      world.executorId,
      {
        commandId, occurredAt: new Date().toISOString(), resultDigest: executorCommandDigest(result),
        state: 'result_acknowledged',
      },
      result,
    )

    // Not uploaded at all, then uploaded only for another command.
    await assert.rejects(receipt(resultWith(reference)), refusedWith('EXECUTOR_COMMAND_RESULT_INVALID'))
    const elsewhere = await world.createCommand('started')
    await record(world, world.upload(elsewhere, screenshot))
    await assert.rejects(receipt(resultWith(reference)), refusedWith('EXECUTOR_COMMAND_RESULT_INVALID'))

    await record(world, world.upload(commandId, screenshot))
    // Kept, but the reference misstates its size or type, or is malformed.
    await assert.rejects(
      receipt(resultWith({ ...reference, byteLength: screenshot.length + 1 })),
      refusedWith('EXECUTOR_COMMAND_RESULT_INVALID'),
    )
    await assert.rejects(
      receipt(resultWith({ ...reference, mimeType: 'image/webp' })),
      refusedWith('EXECUTOR_COMMAND_RESULT_INVALID'),
    )
    await assert.rejects(
      receipt(resultWith({ ...reference, attachmentDigest: 'sha256:short' })),
      refusedWith('EXECUTOR_COMMAND_RESULT_INVALID'),
    )
    assert.equal(
      (await world.prisma.executorCommand.findUniqueOrThrow({ where: { id: commandId } })).state,
      'started',
      'no refused result was recorded',
    )

    await receipt(resultWith(reference))
    const settled = await world.prisma.executorCommand.findUniqueOrThrow({ where: { id: commandId } })
    assert.equal(settled.state, 'result_acknowledged')
    assert.equal(settled.resultDigest, executorCommandDigest(resultWith(reference)))
  })
})

dbTest('a result with no image references is taken as before', async () => {
  await withWorld(async (world) => {
    const commandId = await world.createCommand('started')
    const result = {
      content: [{ text: '[image unavailable: Nessie refused it (A command keeps at most 6 images.)]', type: 'text' }],
      success: true,
    }
    await recordExecutorCommandReceipt(world.prisma, ATTACHMENT_SECRET, world.executorId, {
      commandId, occurredAt: new Date().toISOString(), resultDigest: executorCommandDigest(result),
      state: 'result_acknowledged',
    }, result)
    assert.equal(
      (await world.prisma.executorCommand.findUniqueOrThrow({ where: { id: commandId } })).state,
      'result_acknowledged',
    )
  })
})
