import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  type NormalisedItem,
  type RemoteItemQuery,
  SourceAuthError,
  clearBoardSourceAdapters,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { sealSecret } from '@nessie/runtime'

import { applyInboundItem, type BoardSourceApplyContext } from '../src/board-source-apply.js'
import { searchRemoteTickets } from '../src/board-source-search.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const SECRET = 'test-secret'

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Ship it',
  description: null,
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: null,
  priority: null,
  dueDate: null,
  labels: [],
  fields: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  ...over,
})

/** A stand-in provider that records what it was asked and answers with items. */
const fakeAdapter = (behaviour: {
  items?: NormalisedItem[]
  throws?: Error
  seen?: { container: Record<string, unknown>; query: RemoteItemQuery }[]
}): BoardSourceAdapter =>
  ({
    provider: 'linear',
    allowedHosts: ['api.linear.app'],
    auth: {
      oauth: {
        buildAuthorizeUrl: () => '',
        exchange: async () => {
          throw new Error('unused')
        },
        refresh: async (credential: unknown) => credential,
      },
    },
    listContainers: async () => [],
    describeContainer: async () => ({ states: [], fields: [], members: [] }),
    fetchPage: async () => ({ items: [], checkpoint: { phase: 'incremental' }, hasMore: false }),
    fetchItems: async () => [],
    searchItems: async (
      _ctx: unknown,
      container: Record<string, unknown>,
      query: RemoteItemQuery,
    ) => {
      behaviour.seen?.push({ container, query })
      if (behaviour.throws) throw behaviour.throws
      return behaviour.items ?? []
    },
    ensureWebhook: async () => null,
    verifyWebhook: () => ({ ok: false as const, reason: 'unused' }),
  }) as unknown as BoardSourceAdapter

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  userId: string
}

const seed = async (
  prisma: PrismaClient,
  options: { healthState?: 'active' | 'paused' } = {},
): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Remote tester', email: `remote-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `remote-${suffix}` } })
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
      credential: { create: { accessTokenCiphertext: sealSecret(SECRET, 'token') } },
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
      ...(options.healthState ? { healthState: options.healthState } : {}),
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  clearBoardSourceAdapters()
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

runDatabaseTest('a provider result says whether Nessie already mirrors it', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const mirrored = item({ externalId: 'issue-mirrored', externalKey: 'ENG-1' })
    const notMirrored = item({ externalId: 'issue-new', externalKey: 'ENG-2', title: 'Newer' })
    await applyInboundItem(
      prisma,
      {
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
        identityByExternalUserId: new Map(),
      } satisfies BoardSourceApplyContext,
      mirrored,
    )
    registerBoardSourceAdapter('linear', () => fakeAdapter({ items: [mirrored, notMirrored] }))

    const outcome = await searchRemoteTickets(prisma, {
      organizationId: seeded.organizationId,
      projectIds: [seeded.projectId],
      text: 'ship',
      encryptionSecret: SECRET,
    })

    const byKey = new Map(outcome.matches.map((match) => [match.externalKey, match]))
    assert.equal(typeof byKey.get('ENG-1')?.taskId, 'string')
    // The one Nessie has never seen is exactly what this tool exists to find,
    // and saying so is what stops an assistant trying to move it.
    assert.equal(byKey.get('ENG-2')?.taskId, null)
    assert.deepEqual(outcome.unavailable, [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the search is bounded to the container the source attached', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const seen: { container: Record<string, unknown>; query: RemoteItemQuery }[] = []
  try {
    registerBoardSourceAdapter('linear', () => fakeAdapter({ items: [], seen }))
    await searchRemoteTickets(prisma, {
      organizationId: seeded.organizationId,
      projectIds: [seeded.projectId],
      text: 'ship',
      limit: 5,
      encryptionSecret: SECRET,
    })
    // A credential is lent for one container; a search that ranged wider would
    // read a team the project never attached.
    assert.deepEqual(seen, [{ container: { teamId: 'team-1' }, query: { text: 'ship', limit: 5 } }])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a source that cannot be asked is reported, not silently dropped', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    registerBoardSourceAdapter('linear', () =>
      fakeAdapter({ throws: new SourceAuthError('linear', 'nope') }),
    )
    const outcome = await searchRemoteTickets(prisma, {
      organizationId: seeded.organizationId,
      projectIds: [seeded.projectId],
      text: 'ship',
      encryptionSecret: SECRET,
    })
    assert.deepEqual(outcome.matches, [])
    assert.equal(outcome.unavailable.length, 1)
    assert.equal(outcome.unavailable[0]?.sourceName, 'Engineering')
    assert.match(outcome.unavailable[0]?.reason ?? '', /rejected the credential/)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a paused source is not woken by a search', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma, { healthState: 'paused' })
  const seen: { container: Record<string, unknown>; query: RemoteItemQuery }[] = []
  try {
    registerBoardSourceAdapter('linear', () => fakeAdapter({ items: [item()], seen }))
    const outcome = await searchRemoteTickets(prisma, {
      organizationId: seeded.organizationId,
      projectIds: [seeded.projectId],
      text: 'ship',
      encryptionSecret: SECRET,
    })
    // Paused means a person stopped it; a search must not reach past that.
    assert.deepEqual(seen, [])
    assert.deepEqual(outcome.matches, [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('no projects and no text both answer without dialling out', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const seen: { container: Record<string, unknown>; query: RemoteItemQuery }[] = []
  try {
    registerBoardSourceAdapter('linear', () => fakeAdapter({ items: [item()], seen }))
    assert.deepEqual(
      await searchRemoteTickets(prisma, {
        organizationId: seeded.organizationId,
        projectIds: [],
        text: 'ship',
        encryptionSecret: SECRET,
      }),
      { matches: [], unavailable: [] },
    )
    assert.deepEqual(
      await searchRemoteTickets(prisma, {
        organizationId: seeded.organizationId,
        projectIds: [seeded.projectId],
        text: '   ',
        encryptionSecret: SECRET,
      }),
      { matches: [], unavailable: [] },
    )
    assert.deepEqual(seen, [])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
