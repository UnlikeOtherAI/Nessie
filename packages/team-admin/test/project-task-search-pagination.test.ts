import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { encodeKeysetCursor } from '@nessie/schemas'

import { searchProjectTasks, TicketSearchCursorError } from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const SECRET = 'ticket-search-pagination-secret'

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Pager', email: `ticket-pager-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `ticket-pager-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `ticket-pager-project-${suffix}`, organizationId: organization.id },
  })
  return { organizationId: organization.id, projectId: project.id, userId: user.id }
}

const cleanup = async (
  prisma: PrismaClient,
  seeded: Awaited<ReturnType<typeof seed>>,
): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
  await prisma.$disconnect()
}

const optionsFor = (
  seeded: Awaited<ReturnType<typeof seed>>,
  isReadable: (task: { title: string | null }) => boolean = () => true,
) => ({
  continuation: { secret: SECRET, userId: seeded.userId },
  isReadable: async (task: { title: string | null }) => isReadable(task),
  projectIds: [seeded.projectId],
})

runDatabaseTest('a terminal empty page includes a readable anchor only when reversing', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const [newer] = await Promise.all([
      prisma.task.create({
        data: {
          organizationId: seeded.organizationId,
          projectId: seeded.projectId,
          status: 'inbox',
          title: 'Readable page anchor',
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      }),
      prisma.task.create({
        data: {
          organizationId: seeded.organizationId,
          projectId: seeded.projectId,
          status: 'inbox',
          title: 'Becomes hidden',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
    ])
    const first = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { limit: 1 },
      optionsFor(seeded),
    )
    assert.deepEqual(first.data.map(({ id }) => id), [newer.id])
    assert.ok(first.meta.nextCursor)

    const empty = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: first.meta.nextCursor ?? undefined, limit: 1 },
      optionsFor(seeded, ({ title }) => title === newer.title),
    )
    assert.deepEqual(empty.data, [])
    assert.ok(empty.meta.prevCursor)

    const returned = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: empty.meta.prevCursor ?? undefined, direction: 'backward', limit: 1 },
      optionsFor(seeded, ({ title }) => title === newer.title),
    )
    assert.deepEqual(returned.data.map(({ id }) => id), [newer.id])
  } finally {
    await cleanup(prisma, seeded)
  }
})

runDatabaseTest('backward readable lookahead wins over the scan-budget anchor', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const anchor = { createdAt: new Date('2025-12-31T00:00:00.000Z'), id: randomUUID() }
    const candidates = Array.from({ length: 200 }, (_, index) => ({
      id: randomUUID(),
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      status: 'inbox' as const,
      title: index < 99 ? `Hidden ${index}` : `Visible ${index - 99}`,
      updatedAt: new Date(anchor.createdAt.getTime() + (index + 1) * 1_000),
    }))
    await prisma.task.createMany({
      data: candidates,
    })
    const options = {
      isReadable: async (task: { title: string | null }) => task.title?.startsWith('Visible') ?? false,
      projectIds: [seeded.projectId],
    }
    const first = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: encodeKeysetCursor(anchor), direction: 'backward', limit: 100 },
      options,
    )
    assert.equal(first.data.length, 100)
    assert.ok(first.meta.prevCursor)

    const second = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: first.meta.prevCursor ?? undefined, direction: 'backward', limit: 100 },
      options,
    )
    assert.equal(second.data.length, 1)
    const returnedIds = [...first.data, ...second.data].map(({ id }) => id)
    const expectedIds = candidates.slice(99).map(({ id }) => id)
    assert.equal(new Set(returnedIds).size, returnedIds.length, 'no visible row repeats')
    assert.deepEqual(new Set(returnedIds), new Set(expectedIds), 'every visible row is returned')
  } finally {
    await cleanup(prisma, seeded)
  }
})

runDatabaseTest('authenticated cursors bind viewer, tenant, query, entitlement, and expiry', async (t) => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await prisma.task.createMany({
      data: ['Bound alpha', 'Bound beta'].map((title) => ({
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        status: 'inbox' as const,
        title,
      })),
    })
    const filters = { limit: 1, text: 'Bound' }
    const first = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      filters,
      optionsFor(seeded),
    )
    const cursor = first.meta.nextCursor
    assert.ok(cursor)
    assert.equal(cursor.includes(seeded.userId), false)
    assert.equal(cursor.includes(seeded.organizationId), false)
    assert.equal(cursor.includes(seeded.projectId), false)

    const rejects = async (
      organizationId: string,
      nextFilters: typeof filters & { cursor: string },
      projectIds: string[],
      userId: string,
    ) => assert.rejects(
      searchProjectTasks(prisma, organizationId, nextFilters, {
        continuation: { secret: SECRET, userId },
        isReadable: async () => true,
        projectIds,
      }),
      TicketSearchCursorError,
    )
    await rejects(seeded.organizationId, { ...filters, cursor }, [seeded.projectId], randomUUID())
    await rejects(randomUUID(), { ...filters, cursor }, [seeded.projectId], seeded.userId)
    await rejects(seeded.organizationId, { ...filters, cursor, text: 'Other' }, [seeded.projectId], seeded.userId)
    await rejects(seeded.organizationId, { ...filters, cursor }, [randomUUID()], seeded.userId)
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    await rejects(seeded.organizationId, { ...filters, cursor: tampered }, [seeded.projectId], seeded.userId)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 + 1 })
    await rejects(seeded.organizationId, { ...filters, cursor }, [seeded.projectId], seeded.userId)
  } finally {
    await cleanup(prisma, seeded)
  }
})
