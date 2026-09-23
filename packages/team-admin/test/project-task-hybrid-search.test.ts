import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'

import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { searchProjectTasksHybrid } from '../src/index.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const vectorLiteral = (head: number): string => {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)
  values[0] = head
  return `[${values.join(',')}]`
}

dbTest('hybrid ticket search fuses full text and embeddings inside entitlement gates', async (t) => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Ticket searcher', email: `hybrid-ticket-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({
    data: { name: `hybrid-ticket-${suffix}` },
  })
  const [accessibleProject, hiddenProject] = await Promise.all([
    prisma.project.create({
      data: { name: 'Accessible search project', organizationId: organization.id },
    }),
    prisma.project.create({
      data: { name: 'Hidden search project', organizationId: organization.id },
    }),
  ])
  const [lexical, semantic, disclosureHidden, wrongProject] = await Promise.all([
    prisma.task.create({
      data: {
        createdByUserId: user.id,
        organizationId: organization.id,
        projectId: accessibleProject.id,
        title: 'Ocean launch checklist',
      },
    }),
    prisma.task.create({
      data: {
        createdByUserId: user.id,
        detail: 'Prepare a schedule for the expedition.',
        organizationId: organization.id,
        projectId: accessibleProject.id,
        title: 'Expedition preparation',
      },
    }),
    prisma.task.create({
      data: {
        createdByUserId: user.id,
        organizationId: organization.id,
        projectId: accessibleProject.id,
        title: 'Private derived ocean result',
      },
    }),
    prisma.task.create({
      data: {
        createdByUserId: user.id,
        organizationId: organization.id,
        projectId: hiddenProject.id,
        title: 'Ocean result in another project',
      },
    }),
  ])
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: user.id } })
    await prisma.$disconnect()
  })

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO task_embeddings (
      id, task_id, content_hash, embedding, embedding_model, dims, status,
      created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${semantic.id}::uuid, ${'a'.repeat(64)},
      ${vectorLiteral(1)}::vector, 'test-embedding-model', ${EMBEDDING_DIMENSIONS},
      'indexed', now(), now()
    )
  `)

  const result = await searchProjectTasksHybrid(
    prisma,
    {
      embeddingModel: 'test-embedding-model',
      organizationId: organization.id,
      projectIds: [accessibleProject.id],
      query: 'ocean',
      queryEmbedding: Array.from(
        { length: EMBEDDING_DIMENSIONS },
        (_value, index) => index === 0 ? 1 : 0,
      ),
    },
    { isReadable: async (task) => task.id !== disclosureHidden.id },
  )

  const ids = new Set(result.data.map((task) => task.id))
  assert.ok(ids.has(lexical.id), 'the deterministic full-text arm survives fusion')
  assert.ok(ids.has(semantic.id), 'a meaning-only match is returned from the vector arm')
  assert.ok(!ids.has(disclosureHidden.id), 'run disclosure is applied after ranking')
  assert.ok(!ids.has(wrongProject.id), 'project entitlement is applied before ranking')
  assert.deepEqual(result.meta, { hasMore: false, nextCursor: null, prevCursor: null })
})
