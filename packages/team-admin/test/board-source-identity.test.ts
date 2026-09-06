import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { NormalisedItem } from '@nessie/board-sources'

import { applyInboundItem, type BoardSourceApplyContext } from '../src/board-source-apply.js'
import {
  autoMatchIdentitiesByEmail,
  autoMatchItemAssignees,
  loadIdentityLinks,
} from '../src/board-source-identity.js'
import { createBoardSource, putBoardSourceMappings } from '../src/board-source-structure.js'

/**
 * Mapping a provider's people onto Nessie's, and saying so honestly when there
 * is nobody to map them to.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  tenantKey: string
  ownerUserId: string
  colleagueUserId: string
  colleagueEmail: string
}

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'linear-issue-1',
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

const seed = async (
  prisma: PrismaClient,
  options: { colleagueDeactivated?: boolean } = {},
): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Source owner', email: `owner-${suffix}@example.test` },
  })
  // Deliberately mixed case: the provider's address and ours are compared
  // case-folded, which is the only folding the match does.
  const colleagueEmail = `Colleague-${suffix}@Example.test`
  const colleague = await prisma.user.create({
    data: { displayName: 'Pavel Fuchs', email: colleagueEmail.toLowerCase() },
  })
  const organization = await prisma.organization.create({ data: { name: `identity-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, userId: owner.id },
      {
        organizationId: organization.id,
        userId: colleague.id,
        ...(options.colleagueDeactivated ? { deactivatedAt: new Date() } : {}),
      },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: owner.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `workspace-${suffix}`,
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
      createdByUserId: owner.id,
      stateMapping: [
        {
          externalStateId: 'state-todo',
          externalStateName: 'Todo',
          category: 'todo',
          isDefaultForCategory: true,
        },
      ],
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    tenantKey: connection.externalTenantId,
    ownerUserId: owner.id,
    colleagueUserId: colleague.id,
    colleagueEmail,
  }
}

const tenantOf = (seeded: Seed) =>
  ({
    organizationId: seeded.organizationId,
    provider: 'linear' as const,
    externalTenantKey: seeded.tenantKey,
  })

const context = (
  seeded: Seed,
  identity: BoardSourceApplyContext['identityByExternalUserId'],
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

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [seeded.ownerUserId, seeded.colleagueUserId] } },
  })
}

runDatabaseTest('an upstream assignee is matched to a colleague by email', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const known = await loadIdentityLinks(prisma, tenantOf(seeded))
    const assigned = item({
      assignee: {
        externalUserId: 'linear-user-1',
        displayName: 'Pavel Fuchs',
        email: seeded.colleagueEmail,
      },
    })
    await autoMatchItemAssignees(prisma, tenantOf(seeded), [assigned], known)
    await applyInboundItem(prisma, context(seeded, known), assigned)

    const link = await prisma.boardSourceIdentityLink.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, externalUserId: 'linear-user-1' },
    })
    assert.equal(link.userId, seeded.colleagueUserId)
    assert.equal(link.matchedBy, 'email')

    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: seeded.projectId },
      include: { externalLink: true },
    })
    assert.equal(task.assigneeUserId, seeded.colleagueUserId)
    // Nobody is named twice: the card reads the Nessie identity, so the
    // provider's own name is not also carried.
    assert.equal(task.externalLink?.remoteAssigneeDisplay, null)
    assert.equal(task.status, 'assigned')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a deactivated member is not somebody upstream work resolves to', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, { colleagueDeactivated: true })
  try {
    const matched = await autoMatchIdentitiesByEmail(prisma, tenantOf(seeded), [
      { externalUserId: 'linear-user-1', displayName: 'Pavel Fuchs', email: seeded.colleagueEmail },
    ])
    assert.deepEqual(matched, [])
    assert.equal(
      await prisma.boardSourceIdentityLink.count({
        where: { organizationId: seeded.organizationId },
      }),
      0,
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an unknown upstream person keeps their provider name on the card', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const known = await loadIdentityLinks(prisma, tenantOf(seeded))
    const assigned = item({
      assignee: {
        externalUserId: 'linear-user-2',
        displayName: 'Michaela Brathova',
        email: `stranger-${randomUUID()}@example.test`,
      },
    })
    await autoMatchItemAssignees(prisma, tenantOf(seeded), [assigned], known)
    await applyInboundItem(prisma, context(seeded, known), assigned)

    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: seeded.projectId },
      include: { externalLink: true },
    })
    assert.equal(task.assigneeUserId, null)
    assert.equal(task.externalLink?.remoteAssigneeDisplay, 'Michaela Brathova')
    // Nobody Nessie knows is on it, so it is not `assigned`.
    assert.equal(task.status, 'inbox')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a link a person chose is never re-decided by an email match', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    // The deliberate "not this person": a row that names nobody.
    await prisma.boardSourceIdentityLink.create({
      data: {
        organizationId: seeded.organizationId,
        provider: 'linear',
        externalTenantKey: seeded.tenantKey,
        externalUserId: 'linear-user-1',
        externalDisplayName: 'Pavel Fuchs',
        matchedBy: 'manual',
        createdByUserId: seeded.ownerUserId,
      },
    })

    const matched = await autoMatchIdentitiesByEmail(prisma, tenantOf(seeded), [
      { externalUserId: 'linear-user-1', displayName: 'Pavel Fuchs', email: seeded.colleagueEmail },
    ])
    assert.deepEqual(matched, [])
    const link = await prisma.boardSourceIdentityLink.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, externalUserId: 'linear-user-1' },
    })
    assert.equal(link.userId, null)
    assert.equal(link.matchedBy, 'manual')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('mapping somebody by hand reaches the cards already mirrored', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const stranger = item({
      assignee: { externalUserId: 'linear-user-3', displayName: 'Pavel Fuchs' },
    })
    await applyInboundItem(prisma, context(seeded, new Map()), stranger)

    const before = await prisma.task.findFirstOrThrow({
      where: { projectId: seeded.projectId },
      include: { externalLink: true },
    })
    assert.equal(before.externalLink?.remoteAssigneeDisplay, 'Pavel Fuchs')
    assert.equal(before.status, 'inbox')

    const saved = await putBoardSourceMappings(prisma, seeded.projectId, seeded.sourceId, {
      stateMapping: [],
      fieldMappings: [],
      identityLinks: [
        {
          externalUserId: 'linear-user-3',
          externalDisplayName: 'Pavel Fuchs',
          userId: seeded.colleagueUserId,
        },
      ],
      actorUserId: seeded.ownerUserId,
    })
    assert.ok(!('error' in saved))

    const after = await prisma.task.findUniqueOrThrow({
      where: { id: before.id },
      include: { externalLink: true },
    })
    assert.equal(after.assigneeUserId, seeded.colleagueUserId)
    assert.equal(after.externalLink?.remoteAssigneeDisplay, null)
    assert.equal(after.status, 'assigned')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('saving the People table leaves an email match as an email match', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await autoMatchIdentitiesByEmail(prisma, tenantOf(seeded), [
      { externalUserId: 'linear-user-1', displayName: 'Pavel Fuchs', email: seeded.colleagueEmail },
    ])

    // What the panel sends on any save: every member, including the matched one
    // and the strangers it has no answer for.
    const saved = await putBoardSourceMappings(prisma, seeded.projectId, seeded.sourceId, {
      stateMapping: [],
      fieldMappings: [],
      identityLinks: [
        {
          externalUserId: 'linear-user-1',
          externalDisplayName: 'Pavel Fuchs',
          userId: seeded.colleagueUserId,
        },
        { externalUserId: 'linear-user-9', externalDisplayName: 'Nobody Here', userId: null },
      ],
      actorUserId: seeded.ownerUserId,
    })
    assert.ok(!('error' in saved))

    const link = await prisma.boardSourceIdentityLink.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, externalUserId: 'linear-user-1' },
    })
    assert.equal(link.matchedBy, 'email')
    // A member nobody decided on gains no row, so a later email match is still
    // free to make one.
    assert.equal(
      await prisma.boardSourceIdentityLink.count({
        where: { organizationId: seeded.organizationId, externalUserId: 'linear-user-9' },
      }),
      0,
    )
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('attaching a container matches the members it already names', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const attached = await createBoardSource(prisma, {
      projectId: seeded.projectId,
      organizationId: seeded.organizationId,
      connectionId: (
        await prisma.boardSource.findUniqueOrThrow({
          where: { id: seeded.sourceId },
          select: { connectionId: true },
        })
      ).connectionId,
      provider: 'linear',
      container: { teamId: 'team-2' },
      containerKey: 'team-2',
      name: 'Design',
      createdByUserId: seeded.ownerUserId,
      description: {
        states: [],
        fields: [],
        members: [
          {
            externalUserId: 'linear-user-1',
            displayName: 'Pavel Fuchs',
            email: seeded.colleagueEmail,
          },
          { externalUserId: 'linear-user-bot', displayName: 'Linear Bot' },
        ],
      },
      fieldTargets: {},
    })
    assert.ok(!('error' in attached))

    const links = await prisma.boardSourceIdentityLink.findMany({
      where: { organizationId: seeded.organizationId },
    })
    // The member with no address gains no row at all: an empty row is the one
    // that would block a later match.
    assert.equal(links.length, 1)
    assert.equal(links[0]?.externalUserId, 'linear-user-1')
    assert.equal(links[0]?.userId, seeded.colleagueUserId)
    assert.equal(links[0]?.matchedBy, 'email')
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
