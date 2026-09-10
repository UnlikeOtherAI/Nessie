import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { NormalisedItem } from '@nessie/board-sources'

import {
  applyInboundItem,
  listUnmappedTicketPeople,
  searchProjectTasks,
  type BoardSourceApplyContext,
} from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const allowAll = { isReadable: async () => true }

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Search tester', email: `search-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `search-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: user.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `org-${suffix}`,
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId: 'team-1' },
      containerKey: 'team-1',
      createdByUserId: user.id,
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    userId: user.id,
  }
}

const context = (
  seeded: Seed,
  identity: Map<string, { userId: string | null; agentId: string | null }> = new Map(),
): BoardSourceApplyContext => ({
  id: seeded.sourceId,
  organizationId: seeded.organizationId,
  projectId: seeded.projectId,
  provider: 'linear',
  stateMapping: [
    {
      externalStateId: 'state-todo',
      externalStateName: 'Todo',
      category: 'todo',
      isDefaultForCategory: true,
    },
  ],
  fieldMappings: [],
  identityByExternalUserId: identity,
})

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: `issue-${randomUUID()}`,
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Ship the mirror',
  description: 'From upstream',
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: null,
  priority: 'high',
  dueDate: null,
  labels: [],
  fields: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  ...over,
})

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

runDatabaseTest('text matches a ticket by the provider key a person says out loud', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, context(seeded), item({ externalKey: 'ENG-214' }))
    await applyInboundItem(
      prisma,
      context(seeded),
      item({ externalKey: 'ENG-999', title: 'Something else' }),
    )

    const byKey = (await searchProjectTasks(prisma, seeded.organizationId, { text: 'eng-214' }, allowAll)).data
    assert.deepEqual(byKey.map((ticket) => ticket.externalLink?.externalKey), ['ENG-214'])

    const byTitle = (await searchProjectTasks(prisma, seeded.organizationId, { text: 'mirror' }, allowAll)).data
    assert.equal(byTitle.length, 1)
    assert.equal(byTitle[0]?.title, 'Ship the mirror')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a provider person with no Nessie account can be searched for', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // Nobody is linked, so the sync records the provider's own person.
    await applyInboundItem(
      prisma,
      context(seeded),
      item({
        title: 'Ada holds this',
        assignee: { externalUserId: 'lin_ada', displayName: 'Ada Lovelace' },
      }),
    )
    await applyInboundItem(prisma, context(seeded), item({ title: 'Nobody holds this' }))

    const byExternalId = (await searchProjectTasks(prisma, seeded.organizationId, {
      unmappedAssignee: 'lin_ada',
    }, allowAll)).data
    assert.deepEqual(byExternalId.map((ticket) => ticket.title), ['Ada holds this'])

    // A person asking will say the name, not the provider's id for it.
    const byName = (await searchProjectTasks(prisma, seeded.organizationId, {
      unmappedAssignee: 'ada love',
    }, allowAll)).data
    assert.deepEqual(byName.map((ticket) => ticket.title), ['Ada holds this'])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a ticket the provider says Ada holds is not "unassigned"', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(
      prisma,
      context(seeded),
      item({
        title: 'Ada holds this',
        assignee: { externalUserId: 'lin_ada', displayName: 'Ada Lovelace' },
      }),
    )
    await applyInboundItem(prisma, context(seeded), item({ title: 'Nobody holds this' }))

    const unassigned = (await searchProjectTasks(prisma, seeded.organizationId, {
      unassigned: true,
    }, allowAll)).data
    assert.deepEqual(unassigned.map((ticket) => ticket.title), ['Nobody holds this'])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a mapped person is a colleague, and disappears from the unmapped list', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const identity = new Map([['lin_ada', { userId: seeded.userId, agentId: null }]])
    await applyInboundItem(
      prisma,
      context(seeded, identity),
      item({
        title: 'Ada holds this',
        assignee: { externalUserId: 'lin_ada', displayName: 'Ada Lovelace' },
      }),
    )

    const people = await listUnmappedTicketPeople(prisma, seeded.organizationId)
    assert.deepEqual(people, [])

    const byUser = (await searchProjectTasks(prisma, seeded.organizationId, {
      assigneeUserId: seeded.userId,
    }, allowAll)).data
    assert.deepEqual(byUser.map((ticket) => ticket.title), ['Ada holds this'])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the unmapped roster is built from the tickets and counts them', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    for (const title of ['One', 'Two']) {
      await applyInboundItem(
        prisma,
        context(seeded),
        item({ title, assignee: { externalUserId: 'lin_ada', displayName: 'Ada Lovelace' } }),
      )
    }
    await applyInboundItem(
      prisma,
      context(seeded),
      item({ title: 'Three', assignee: { externalUserId: 'lin_bob', displayName: 'Bob' } }),
    )

    const people = await listUnmappedTicketPeople(prisma, seeded.organizationId)
    assert.deepEqual(
      people.map((person) => [person.displayName, person.externalUserId, person.ticketCount]),
      [
        ['Ada Lovelace', 'lin_ada', 2],
        ['Bob', 'lin_bob', 1],
      ],
    )
    assert.deepEqual([...new Set(people.map((person) => person.provider))], ['linear'])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a search never reaches a project the caller cannot open', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, context(seeded), item({ title: 'Ship the mirror' }))
    await applyInboundItem(prisma, context(seeded), item({ title: 'Unrelated accessible work' }))

    const withoutMembership = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { text: 'mirror' },
      { ...allowAll, projectIds: [] },
    )
    assert.deepEqual(withoutMembership.data, [])

    const withMembership = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { text: 'mirror' },
      { ...allowAll, projectIds: [seeded.projectId] },
    )
    assert.equal(withMembership.data.length, 1)
    assert.equal(withMembership.data[0]?.title, 'Ship the mirror')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('search pages only readable entitled project tickets', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    for (const title of ['Visible alpha', 'Hidden canary', 'Visible beta']) {
      await applyInboundItem(prisma, context(seeded), item({ title }))
    }
    const otherProject = await prisma.project.create({
      data: { name: `other-${randomUUID()}`, organizationId: seeded.organizationId },
    })
    const inaccessible = await prisma.task.create({
      data: { organizationId: seeded.organizationId, projectId: otherProject.id, status: 'inbox', title: 'Visible private project' },
    })
    const projectless = await prisma.task.create({
      data: { organizationId: seeded.organizationId, status: 'inbox', title: 'Visible personal task' },
    })
    const readable = (task: { title: string | null }) => !task.title?.includes('Hidden')
    const first = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { limit: 1 },
      { isReadable: async (task) => readable(task), projectIds: [seeded.projectId] },
    )
    assert.equal(first.data.length, 1)
    assert.equal(first.meta.hasMore, true, 'a readable row beyond a hidden candidate keeps paging reachable')
    assert.ok(first.meta.nextCursor, 'continuation is derived from the visible row')
    assert.equal(first.data.some((task) => task.id === inaccessible.id || task.id === projectless.id), false)

    const second = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: first.meta.nextCursor ?? undefined, direction: 'forward', limit: 1 },
      { isReadable: async (task) => readable(task), projectIds: [seeded.projectId] },
    )
    assert.equal(second.data.length, 1)
    assert.notEqual(second.data[0]?.id, first.data[0]?.id, 'the visible cursor never repeats a row')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an authenticated continuation reaches a readable ticket after a hidden scan budget', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const visible = await prisma.task.create({
      data: { organizationId: seeded.organizationId, projectId: seeded.projectId, status: 'inbox', title: 'Visible after hidden scan' },
    })
    await prisma.task.createMany({
      data: Array.from({ length: 201 }, (_, index) => ({
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        status: 'inbox' as const,
        title: `Hidden scan canary ${index}`,
      })),
    })
    const options = {
      continuation: { secret: 'ticket-search-test-secret', userId: seeded.userId },
      isReadable: async (task: { title: string | null }) => task.title === visible.title,
      projectIds: [seeded.projectId],
    }
    const first = await searchProjectTasks(prisma, seeded.organizationId, { limit: 10 }, options)
    assert.deepEqual(first.data, [])
    assert.equal(first.meta.hasMore, true)
    assert.match(first.meta.nextCursor ?? '', /^tsc1\./u, 'the hidden anchor is encrypted')

    const second = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: first.meta.nextCursor ?? undefined, limit: 10 },
      options,
    )
    assert.deepEqual(second.data.map((task) => task.id), [visible.id])

    // Going back from the visible row crosses the same hidden stretch in the
    // other direction. Its authenticated cursor must advance even though the
    // intermediary page cannot show a row.
    const backward = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: second.meta.prevCursor ?? undefined, direction: 'backward', limit: 10 },
      options,
    )
    assert.deepEqual(backward.data, [])
    assert.match(backward.meta.prevCursor ?? '', /^tsc1\./u)
    const backwardTail = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { cursor: backward.meta.prevCursor ?? undefined, direction: 'backward', limit: 10 },
      options,
    )
    assert.deepEqual(backwardTail.data, [])
    assert.equal(backwardTail.meta.prevCursor, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
