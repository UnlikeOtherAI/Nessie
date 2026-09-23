import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { TaskEmbedJobPayloadSchema } from '@nessie/schemas'

import {
  claimTaskEmbeddingInTransaction,
  taskContentHash,
} from '../src/task-embedding-claim.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('a task projection claim is atomic, revision-pinned, and project-only', async () => {
  const prisma = new PrismaClient()
  const organization = await prisma.organization.create({
    data: { name: `task-embedding-claim-${randomUUID()}` },
  })
  try {
    const project = await prisma.project.create({
      data: { name: 'Searchable project', organizationId: organization.id },
    })
    const [task, projectless] = await Promise.all([
      prisma.task.create({
        data: {
          detail: 'Coordinate the cutover.',
          organizationId: organization.id,
          projectId: project.id,
          purpose: 'Ship safely',
          title: 'Launch plan',
        },
      }),
      prisma.task.create({
        data: { organizationId: organization.id, title: 'Private projectless work' },
      }),
    ])
    const origin = {
      userId: randomUUID(),
      uoaIdentity: {
        organizationId: 'uoa-org',
        subject: 'uoa-subject',
        teamId: 'uoa-team',
        tokenVersion: 8,
      },
    }
    const claim = (source: typeof task, withOrigin: boolean) =>
      prisma.$transaction((tx) => claimTaskEmbeddingInTransaction(tx, {
        detail: source.detail,
        embeddingModel: 'test-task-model',
        id: source.id,
        organizationId: organization.id,
        purpose: source.purpose,
        title: source.title,
        ...(withOrigin ? { origin } : {}),
      }))

    assert.equal(await claim(task, true), true)
    assert.equal(await claim(task, false), false, 'the sweep cannot replace an origin-bearing claim')
    assert.equal(await claim(projectless, true), false, 'projectless work has no global-search doorway')

    const edited = await prisma.task.update({
      where: { id: task.id },
      // The hash fence compares the exact stored source; tabs at the edge used
      // to be trimmed in JavaScript but not by Postgres `btrim()`.
      data: { title: '\tUpdated launch plan\t' },
    })
    assert.equal(await claim(edited, true), true, 'a new canonical revision makes a new claim')

    const projection = await prisma.$queryRaw<Array<{ content_hash: string; status: string }>>`
      SELECT content_hash, status FROM task_embeddings WHERE task_id = ${task.id}::uuid
    `
    assert.deepEqual(projection, [{ content_hash: taskContentHash(edited), status: 'pending' }])

    const jobs = await prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM queue_jobs
      WHERE topic = 'task.embed' AND payload->>'organizationId' = ${organization.id}
      ORDER BY enqueued_at
    `
    assert.equal(jobs.length, 2)
    const payloads = jobs.map((job) => TaskEmbedJobPayloadSchema.parse(job.payload))
    assert.deepEqual(payloads.map((payload) => payload.origin), [origin, origin])
    assert.deepEqual(
      payloads.map((payload) => payload.contentHash),
      [taskContentHash(task), taskContentHash(edited)],
    )
  } finally {
    await prisma.$executeRaw`
      DELETE FROM queue_jobs WHERE topic = 'task.embed'
        AND payload->>'organizationId' = ${organization.id}
    `
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  }
})
