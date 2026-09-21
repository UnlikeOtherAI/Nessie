import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  type ContainerDescription,
  type NormalisedComment,
  type NormalisedItem,
  type SyncCheckpoint,
  type SyncPage,
  type WebhookDelivery,
  clearBoardSourceAdapters,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { AT_REST_SECRET_PURPOSE, type FileService, sealSecret } from '@nessie/runtime'

import { executeBoardSourceSync } from '../src/control/board-source-sync.js'
import { processBoardSourceWebhook } from '../src/control/board-source-webhook.js'

/**
 * The worker half of comments, labels and files: a sync job that walks the
 * item lane and the comment lane, stores what is pending and tells each
 * touched ticket once; and the webhook deliveries that only a push can carry
 * — a label recolour and a comment deletion. Real database, stand-in adapter.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const ENCRYPTION_SECRET = 'board-source-activity-test-secret'
const SHOT = 'https://uploads.linear.app/ws/1/screen.png'

type Seed = { organizationId: string; projectId: string; sourceId: string; userId: string; teamId: string }

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const teamId = `team-${suffix}`
  const user = await prisma.user.create({
    data: { displayName: 'Sync tester', email: `sync-activity-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `sync-activity-${suffix}` } })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: user.id } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: user.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
      externalTenantId: `tenant-${suffix}`,
      credential: {
        create: {
          accessTokenCiphertext: sealSecret(
            ENCRYPTION_SECRET,
            'lin_api_test',
            AT_REST_SECRET_PURPOSE.boardSourceCredential,
          ),
        },
      },
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId },
      containerKey: teamId,
      createdByUserId: user.id,
      stateMapping: [
        { externalStateId: 'state-todo', externalStateName: 'Todo', category: 'todo', isDefaultForCategory: true },
      ],
      fieldMappings: [{ externalKey: 'labels', externalLabel: 'Labels', target: 'native:labels' }],
      checkpoint: { phase: 'initial' },
      nextRunAt: new Date(),
    },
  })
  return { organizationId: organization.id, projectId: project.id, sourceId: source.id, userId: user.id, teamId }
}

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.attachment.deleteMany({ where: { organizationId: seeded.organizationId } })
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

const issue = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Mirror the thread',
  description: `Broken: ![shot](${SHOT})`,
  stateId: 'state-todo',
  stateName: 'Todo',
  assignee: null,
  priority: null,
  dueDate: null,
  labels: [{ id: 'l-bug', label: 'Bug', color: '#eb5757' }],
  fields: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  archived: false,
  attachments: [
    { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: '2026-09-01T00:00:00.000Z' },
  ],
  ...over,
})

const comment = (over: Partial<NormalisedComment> = {}): NormalisedComment => ({
  externalId: 'comment-1',
  issueExternalId: 'issue-1',
  body: `Repro ![](${SHOT})`,
  author: { externalUserId: 'linear-alice', displayName: 'Alice Upstream' },
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  ...over,
})

type Script = {
  pages?: SyncPage[]
  describe?: ContainerDescription
  delivery?: WebhookDelivery
  items?: NormalisedItem[]
}

const standInAdapter = (script: Script): BoardSourceAdapter =>
  ({
    provider: 'linear',
    allowedHosts: ['api.linear.app'],
    assetHosts: ['uploads.linear.app'],
    auth: {
      apiKey: {
        form: { createUrl: 'x', createLabel: 'x', fields: [] },
        verify: async () => {
          throw new Error('unused')
        },
      },
    },
    listContainers: async () => [],
    describeContainer: async () =>
      script.describe ?? { states: [], fields: [], members: [], labels: [] },
    fetchPage: async (_ctx: unknown, _container: unknown, _checkpoint: SyncCheckpoint) => {
      const page = script.pages?.shift()
      if (!page) throw new Error('no page scripted')
      return page
    },
    fetchItems: async () => script.items ?? [],
    searchItems: async () => [],
    ensureWebhook: async () => null,
    verifyWebhook: () => true,
    parseWebhook: () => script.delivery as WebhookDelivery,
    applyChange: async () => {
      throw new Error('unused')
    },
    fetchAsset: async () => ({
      stream: Readable.from([Buffer.from('png-bytes')]),
      contentType: 'image/png',
      sizeBytes: 9,
    }),
  }) as unknown as BoardSourceAdapter

const deps = (prisma: PrismaClient, seen: { activity: string[]; boards: number; stores: number }) => ({
  prisma,
  encryptionSecret: ENCRYPTION_SECRET,
  publicApiUrl: null,
  enqueueHealthAlert: async () => {},
  publishBoardUpdated: async () => {
    seen.boards += 1
  },
  publishTaskActivity: async (input: { taskId: string }) => {
    seen.activity.push(input.taskId)
  },
  fileService: {
    store: async (input) => {
      seen.stores += 1
      let bytes = 0
      for await (const chunk of input.body) bytes += (chunk as Buffer).byteLength
      const attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          kind: 'image',
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(bytes),
          storageKey: `${input.organizationId}/${randomUUID()}`,
        },
      })
      return { attachment, bytesWritten: bytes }
    },
  } as Pick<FileService, 'store'>,
})

runDatabaseTest('a sync walks both lanes, stores the image and tells the ticket once', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const seen = { activity: [] as string[], boards: 0, stores: 0 }
  try {
    clearBoardSourceAdapters()
    registerBoardSourceAdapter('linear', () =>
      standInAdapter({
        describe: {
          states: [],
          fields: [],
          members: [],
          // `Perf` is on no issue yet; an initial sync still offers it.
          labels: [
            { id: 'l-bug', label: 'Bug', color: '#eb5757' },
            { id: 'l-perf', label: 'Perf', color: '#f2c94c' },
          ],
        },
        pages: [
          {
            items: [issue()],
            hasMore: true,
            checkpoint: { phase: 'incremental', lane: 'comments', commentsSince: '1970-01-01T00:00:00.000Z' },
          },
          {
            items: [],
            comments: [comment()],
            hasMore: false,
            checkpoint: { phase: 'incremental', lane: 'items', commentsSince: '2026-09-03T00:00:00.000Z' },
          },
        ],
      }),
    )

    const result = await executeBoardSourceSync(deps(prisma, seen), { sourceId: seeded.sourceId })
    assert.equal(result.outcome, 'completed')

    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    const asset = await prisma.taskExternalAsset.findFirstOrThrow({ where: { sourceId: seeded.sourceId } })
    assert.equal(asset.status, 'stored')
    assert.equal(seen.stores, 1)
    assert.equal(task.detail, `Broken: ![shot](/api/attachments/${asset.attachmentId})`)
    const stored = await prisma.taskComment.findFirstOrThrow({ where: { sourceId: seeded.sourceId } })
    assert.equal(stored.body, `Repro ![](/api/attachments/${asset.attachmentId})`)

    const labels = await prisma.taskLabel.findMany({
      where: { projectId: seeded.projectId },
      orderBy: { name: 'asc' },
    })
    assert.deepEqual(labels.map((label) => `${label.name}:${label.color}`), ['Bug:#eb5757', 'Perf:#f2c94c'])

    // One task.activity for the one ticket, however many of its comments and
    // files the job touched.
    assert.deepEqual(seen.activity, [task.id])
    assert.ok(seen.boards >= 1)

    const source = await prisma.boardSource.findUniqueOrThrow({ where: { id: seeded.sourceId } })
    assert.equal((source.checkpoint as SyncCheckpoint).lane, 'items')
  } finally {
    clearBoardSourceAdapters()
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an IssueLabel delivery re-describes the container and recolours the label', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const seen = { activity: [] as string[], boards: 0, stores: 0 }
  try {
    await prisma.taskLabel.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        name: 'Bug',
        normalizedName: 'bug',
        color: '#eb5757',
        sourceId: seeded.sourceId,
        externalId: 'l-bug',
      },
    })
    clearBoardSourceAdapters()
    registerBoardSourceAdapter('linear', () =>
      standInAdapter({
        delivery: { deliveryId: 'd1', containerKey: seeded.teamId, externalIds: [], resource: 'label' },
        describe: {
          states: [],
          fields: [],
          members: [],
          labels: [{ id: 'l-bug', label: 'Defect', color: '#000000' }],
        },
      }),
    )

    const outcome = await processBoardSourceWebhook(deps(prisma, seen), {
      provider: 'linear',
      headers: {},
      rawBody: JSON.stringify({ type: 'IssueLabel' }),
    })
    assert.equal(outcome.applied, 0, 'no item was applied')
    const label = await prisma.taskLabel.findFirstOrThrow({ where: { sourceId: seeded.sourceId } })
    assert.equal(label.name, 'Defect')
    assert.equal(label.color, '#000000')
    assert.equal(seen.boards, 1, 'the board repaints its pills')
  } finally {
    clearBoardSourceAdapters()
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a Comment removal soft-deletes the comment the re-read no longer has', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  const seen = { activity: [] as string[], boards: 0, stores: 0 }
  try {
    const run = (delivery: WebhookDelivery, items: NormalisedItem[]) => {
      clearBoardSourceAdapters()
      registerBoardSourceAdapter('linear', () => standInAdapter({ delivery, items }))
      return processBoardSourceWebhook(deps(prisma, seen), { provider: 'linear', headers: {}, rawBody: '{}' })
    }

    await run(
      { deliveryId: 'd1', containerKey: seeded.teamId, externalIds: ['issue-1'], resource: 'item' },
      [issue({ attachments: [], comments: [comment({ body: 'Keep me' }), comment({ externalId: 'comment-2', body: 'Gone soon' })] })],
    )
    assert.equal(await prisma.taskComment.count({ where: { sourceId: seeded.sourceId, deletedAt: null } }), 2)

    seen.activity = []
    await run(
      {
        deliveryId: 'd2',
        containerKey: seeded.teamId,
        externalIds: ['issue-1'],
        resource: 'item',
        removedCommentExternalIds: ['comment-2'],
      },
      [issue({ attachments: [], comments: [comment({ body: 'Keep me' })] })],
    )
    const gone = await prisma.taskComment.findFirstOrThrow({ where: { externalId: 'comment-2' } })
    assert.ok(gone.deletedAt)
    assert.equal(gone.body, '')
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    assert.deepEqual(seen.activity, [task.id])
  } finally {
    clearBoardSourceAdapters()
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
