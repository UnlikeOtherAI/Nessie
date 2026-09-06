import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { createFileService, QuotaExceededError } from '../src/files/index.js'
import { collectStream, type Storage } from '../src/storage/index.js'

/**
 * The storage quota as an admission control.
 *
 * `FileService.store` checked the quota and then, in separate statements, wrote
 * the attachment row and the usage events. Two uploads racing each other both
 * read a total that neither had contributed to yet, and both were stored — the
 * "exact modulo concurrent uploads" caveat the old comment carried. The check
 * and the usage events now share one transaction under the organisation's
 * advisory lock.
 *
 * DB-backed on purpose: the guarantee is that the loser reads the winner's
 * COMMITTED usage event, which needs two real connections.
 *
 * Know what the racing test below does and does not prove. Wall-clock
 * concurrency reproduces the bug only sometimes — with the advisory lock
 * removed it still passed two runs in three — so treat it as covering the
 * ADMITTED-PATH ARITHMETIC (one attachment, one usage event, no orphaned
 * object), not as evidence the lock is there. The mutual exclusion is proved
 * deterministically by the last test in this file, which holds the exact lock
 * from another connection.
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const makeStorage = (): Storage & { blobs: Map<string, Buffer> } => {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    putStream: async (key, body) => {
      const buf = await collectStream(body)
      blobs.set(key, buf)
      return { bytesWritten: buf.length }
    },
    getStream: async (key) => (blobs.has(key) ? Readable.from(blobs.get(key) as Buffer) : null),
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    get: async (key) => blobs.get(key) ?? null,
    delete: async (key) => {
      blobs.delete(key)
    },
  }
}

runIfDatabase(
  'two uploads that each fit alone but not together: exactly one is stored',
  async () => {
    const prisma = new PrismaClient()
    const organizationId = randomUUID()
    const storage = makeStorage()
    const files = createFileService({ maxUploadBytes: 1_000_000, prisma, storage })
    const attribution = { actorId: randomUUID(), actorType: 'user' as const, organizationId }

    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Storage quota race' } })
      // 20 bytes of room and two 11-byte uploads: either alone fits, the pair
      // does not.
      await prisma.budget.create({
        data: {
          mode: 'off',
          organizationId,
          scopeId: organizationId,
          scopeType: 'organization',
          storageLimitBytes: 20n,
        },
      })

      const upload = (filename: string) =>
        files.store({
          attribution,
          body: Readable.from(Buffer.from('hello world')),
          filename,
          mime: 'text/plain',
          organizationId,
          uploaderId: null,
        })

      const outcomes = await Promise.allSettled([upload('a.txt'), upload('b.txt')])
      const stored = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const refused = outcomes.filter((outcome) => outcome.status === 'rejected')
      assert.equal(stored.length, 1, 'exactly one upload may be admitted')
      assert.equal(refused.length, 1)
      assert.ok(
        (refused[0] as PromiseRejectedResult).reason instanceof QuotaExceededError,
        'the refusal must be the quota, not an incidental error',
      )

      // Usage matches what is actually stored, and the refused upload left no
      // attachment row and no orphaned object behind.
      assert.equal((await files.usageForScope({ organizationId })).toString(), '11')
      assert.equal(await prisma.attachment.count({ where: { organizationId } }), 1)
      assert.equal(storage.blobs.size, 1)
    } finally {
      await prisma.storageUsageEvent.deleteMany({ where: { organizationId } })
      await prisma.attachment.deleteMany({ where: { organizationId } })
      await prisma.budget.deleteMany({ where: { organizationId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.$disconnect()
    }
  },
)

runIfDatabase('an upload that fits is stored with its usage event in one step', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const storage = makeStorage()
  const files = createFileService({ maxUploadBytes: 1_000_000, prisma, storage })
  const attribution = { actorId: randomUUID(), actorType: 'user' as const, organizationId }

  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Storage quota fit' } })
    await prisma.budget.create({
      data: {
        mode: 'off',
        organizationId,
        scopeId: organizationId,
        scopeType: 'organization',
        storageLimitBytes: 100n,
      },
    })

    const { attachment, bytesWritten } = await files.store({
      attribution,
      body: Readable.from(Buffer.from('hello world')),
      filename: 'note.txt',
      mime: 'text/plain',
      organizationId,
      uploaderId: null,
    })
    assert.equal(bytesWritten, 11)

    // The row and the event are the same commit: a reader that can see the
    // attachment can always see the bytes it accounts for.
    assert.equal((await files.usageForScope({ organizationId })).toString(), '11')
    assert.equal(
      await prisma.storageUsageEvent.count({ where: { attachmentId: attachment.id } }),
      1,
    )

    // Deleting frees the bytes again, so the quota is not a ratchet.
    assert.equal(await files.delete(attachment.id, organizationId, attribution), true)
    assert.equal((await files.usageForScope({ organizationId })).toString(), '0')
  } finally {
    await prisma.storageUsageEvent.deleteMany({ where: { organizationId } })
    await prisma.attachment.deleteMany({ where: { organizationId } })
    await prisma.budget.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
  }
})

/**
 * The mutual exclusion itself, proved rather than raced.
 *
 * The race above is real but not reliable evidence: with the advisory lock
 * removed it still passed two runs in three, because the two uploads tend to
 * queue rather than interleave at the moment that decides. So this test holds
 * the EXACT lock `withStorageAdmission` takes — same name, same
 * `hashtextextended` derivation — on another connection, and shows an upload
 * cannot get past it. Remove the lock from the gate and the store completes
 * while the lock is held, failing the first assertion.
 *
 * The holder uses `pg_advisory_xact_lock` inside an interactive transaction
 * rather than a session-level `pg_advisory_lock`: Prisma pools connections, so
 * a session lock and its unlock could land on two different backends, while an
 * interactive transaction keeps one for its whole life.
 */
runIfDatabase('an upload waits for the organisation\'s storage admission lock', async () => {
  const prisma = new PrismaClient()
  const holder = new PrismaClient()
  const organizationId = randomUUID()
  const storage = makeStorage()
  const files = createFileService({ maxUploadBytes: 1_000_000, prisma, storage })
  const attribution = { actorId: randomUUID(), actorType: 'user' as const, organizationId }

  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // Resolved by the holder once the lock is actually its own. Waiting on a
  // fixed sleep instead raced the very thing under test: on a loaded runner
  // the holder could still be acquiring when the assertion started, the
  // contender sailed through, and the failure read as "the gate is not taking
  // the lock" when the gate was fine. It failed CI twice on an admin-only
  // branch in September 2026.
  let acquired!: () => void
  const holdsLock = new Promise<void>((resolve) => {
    acquired = resolve
  })

  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Storage lock' } })

    const lockName = `storage:organization:${organizationId}`
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}::text, 0))`
        acquired()
        await held
      },
      { timeout: 30_000 },
    )
    // Bounded by the holder's own transaction timeout rather than by a guess:
    // if it ends or fails without ever taking the lock, this says so instead
    // of hanging. `holderEnded` handles both settlements, so the loser of the
    // race never becomes an unhandled rejection.
    const holderEnded = holding.then(() => 'ended' as const, () => 'failed' as const)
    assert.equal(
      await Promise.race([holdsLock.then(() => 'acquired' as const), holderEnded]),
      'acquired',
      'the holder must own the lock before the contender starts',
    )

    const upload = files.store({
      attribution,
      body: Readable.from(Buffer.from('hello world')),
      filename: 'blocked.txt',
      mime: 'text/plain',
      organizationId,
      uploaderId: null,
    })
    const pending = Symbol('pending')
    const raced = await Promise.race([
      upload.then(() => 'settled' as const),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 1_000)),
    ])
    assert.equal(
      raced,
      pending,
      'an upload must block while another session holds the organisation lock; it did not, so the gate is not taking it',
    )

    release()
    await holding
    const { attachment } = await upload
    assert.ok(attachment.id)
    assert.equal((await files.usageForScope({ organizationId })).toString(), '11')
  } finally {
    release()
    await prisma.storageUsageEvent.deleteMany({ where: { organizationId } })
    await prisma.attachment.deleteMany({ where: { organizationId } })
    await prisma.budget.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.$disconnect()
    await holder.$disconnect()
  }
})
