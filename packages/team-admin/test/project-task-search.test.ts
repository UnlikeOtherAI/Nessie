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

    const byKey = await searchProjectTasks(prisma, seeded.organizationId, { text: 'eng-214' })
    assert.deepEqual(byKey.map((ticket) => ticket.externalLink?.externalKey), ['ENG-214'])

    const byTitle = await searchProjectTasks(prisma, seeded.organizationId, { text: 'mirror' })
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

    const byExternalId = await searchProjectTasks(prisma, seeded.organizationId, {
      unmappedAssignee: 'lin_ada',
    })
    assert.deepEqual(byExternalId.map((ticket) => ticket.title), ['Ada holds this'])

    // A person asking will say the name, not the provider's id for it.
    const byName = await searchProjectTasks(prisma, seeded.organizationId, {
      unmappedAssignee: 'ada love',
    })
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

    const unassigned = await searchProjectTasks(prisma, seeded.organizationId, {
      unassigned: true,
    })
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

    const byUser = await searchProjectTasks(prisma, seeded.organizationId, {
      assigneeUserId: seeded.userId,
    })
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

    const withoutMembership = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { text: 'mirror' },
      { accessibleProjectIds: [], actorUserId: randomUUID() },
    )
    assert.deepEqual(withoutMembership, [])

    const withMembership = await searchProjectTasks(
      prisma,
      seeded.organizationId,
      { text: 'mirror' },
      { accessibleProjectIds: [seeded.projectId], actorUserId: seeded.userId },
    )
    assert.equal(withMembership.length, 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
