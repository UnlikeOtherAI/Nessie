import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { ExecutorCommandReceiptState } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { EXECUTOR_RESULT_IMAGE_MAX_BYTES } from '@nessie/schemas'

import {
  authorizeExecutorDaemonControlCall,
  EXECUTOR_ATTACHMENT_RATE_MAXIMUM,
  ExecutorError,
  recordAuthorizedExecutorCommandAttachment,
  recordExecutorCommandReceipt,
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

const record = (world: AttachmentWorld, input: ReturnType<AttachmentWorld['upload']>, fileService?: FileService) =>
  recordAuthorizedExecutorCommandAttachment(world.prisma, {
    encryptionSecret: ATTACHMENT_SECRET,
    fileService: fileService ?? world.fileService,
  }, input)

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

dbTest('an executor over its image rate is told to wait, not refused', async () => {
  await withWorld(async (world) => {
    // Another command of the same executor already kept the window's worth.
    const busy = await world.createCommand('started')
    await world.prisma.attachment.createMany({
      data: Array.from({ length: EXECUTOR_ATTACHMENT_RATE_MAXIMUM }, (_, index) => ({
        contentByteLength: 100, contentDigest: `sha256:${String(index).padStart(64, '0')}`,
        executorCommandId: busy, filename: `seeded-${index}.png`, kind: 'image', mime: 'image/png',
        organizationId: world.organizationId, sizeBytes: 100n, storageKey: `${world.organizationId}/seeded-${index}`,
        uploaderId: world.holderId,
      })),
    })
    const commandId = await world.createCommand('started')
    await assert.rejects(
      record(world, world.upload(commandId, pngBytes(500))),
      refusedWith('EXECUTOR_COMMAND_ATTACHMENT_RATE_LIMITED'),
    )
    // An hour later the same rows no longer count.
    await world.prisma.attachment.updateMany({
      where: { executorCommandId: busy }, data: { createdAt: new Date(Date.now() - 3_600_000) },
    })
    assert.ok(await record(world, world.upload(commandId, pngBytes(500))))
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
