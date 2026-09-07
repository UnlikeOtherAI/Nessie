import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { boardSourceSyncClaimKey, enqueueBoardSourceSync } from '../../src/queue.js'
import { runDatabaseTest } from './support.js'

runDatabaseTest('a completed source poll does not suppress the next claim', async (t) => {
  const prisma = new PrismaClient()
  const sourceId = randomUUID()
  const firstClaim = new Date('2026-09-07T07:37:40.000Z')
  const secondClaim = new Date('2026-09-07T07:42:40.000Z')
  const firstKey = boardSourceSyncClaimKey(sourceId, firstClaim)
  const secondKey = boardSourceSyncClaimKey(sourceId, secondClaim)

  t.after(async () => {
    await prisma.queueJob.deleteMany({
      where: { idempotencyKey: { in: [firstKey, secondKey] } },
    })
    await prisma.$disconnect()
  })

  assert.equal(await enqueueBoardSourceSync(prisma, { sourceId }, firstClaim), true)
  const first = await prisma.queueJob.findUniqueOrThrow({
    where: { idempotencyKey: firstKey },
    select: { id: true },
  })
  await prisma.queueJob.update({ where: { id: first.id }, data: { status: 'done' } })

  // The fresh claim, rather than the source's unchanged cursor, identifies the
  // next polling attempt. Its key must survive the first job's terminal row.
  assert.equal(await enqueueBoardSourceSync(prisma, { sourceId }, secondClaim), true)
  assert.equal(await enqueueBoardSourceSync(prisma, { sourceId }, secondClaim), false)

  const jobs = await prisma.queueJob.findMany({
    where: { idempotencyKey: { in: [firstKey, secondKey] } },
    select: { idempotencyKey: true, status: true },
  })
  assert.deepEqual(
    jobs.sort((left, right) => left.idempotencyKey!.localeCompare(right.idempotencyKey!)),
    [
      { idempotencyKey: firstKey, status: 'done' },
      { idempotencyKey: secondKey, status: 'pending' },
    ].sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)),
  )
})
