import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  type AssetStream,
  type NormalisedComment,
  type NormalisedItem,
  SourceHttpError,
  itemFingerprint,
  streamFromSourceResponse,
} from '@nessie/board-sources'
import type { FileService } from '@nessie/runtime'

import {
  type ActivitySourceContext,
  applyInboundAssets,
  applyInboundComments,
  fetchPendingAssets,
  removeInboundComments,
} from '../src/board-source-apply-activity.js'
import { applyInboundItem, type BoardSourceApplyContext } from '../src/board-source-apply.js'
import { reprojectIdentityLinks } from '../src/board-source-identity.js'

/**
 * The comment, label and file halves of the board-source import, against a
 * real database with a stand-in adapter and a stand-in file store. Real rows,
 * because every rule here is a uniqueness key or a partition of existing rows
 * — exactly what an in-memory fake would model by construction.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const MIB = 1024 * 1024
const SHOT = 'https://uploads.linear.app/ws/1/screen.png'
const CLIP = 'https://uploads.linear.app/ws/2/clip.gif'

const item = (over: Partial<NormalisedItem> = {}): NormalisedItem => ({
  externalId: 'issue-1',
  externalKey: 'ENG-1',
  url: 'https://linear.app/acme/issue/ENG-1',
  title: 'Mirror the thread',
  description: `Broken: ![shot](${SHOT})`,
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

const comment = (over: Partial<NormalisedComment> = {}): NormalisedComment => ({
  externalId: 'comment-1',
  issueExternalId: 'issue-1',
  body: 'First',
  author: { externalUserId: 'linear-alice', displayName: 'Alice Upstream' },
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  url: 'https://linear.app/acme/issue/ENG-1#comment-1',
  ...over,
})

type Seed = {
  organizationId: string
  projectId: string
  sourceId: string
  userId: string
  ownerUserId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Activity tester', email: `activity-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `activity-${suffix}` } })
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
      externalTenantId: `tenant-${suffix}`,
    },
  })
  const source = await prisma.boardSource.create({
    data: {
      projectId: project.id,
      organizationId: organization.id,
      connectionId: connection.id,
      provider: 'linear',
      name: 'Engineering',
      container: { teamId: `team-${suffix}` },
      containerKey: `team-${suffix}`,
      createdByUserId: user.id,
      fieldMappings: [{ externalKey: 'labels', externalLabel: 'Labels', target: 'native:labels' }],
    },
  })
  return {
    organizationId: organization.id,
    projectId: project.id,
    sourceId: source.id,
    userId: user.id,
    ownerUserId: user.id,
  }
}

const applyContext = (seeded: Seed): BoardSourceApplyContext => ({
  id: seeded.sourceId,
  organizationId: seeded.organizationId,
  projectId: seeded.projectId,
  provider: 'linear',
  stateMapping: [
    { externalStateId: 'state-todo', externalStateName: 'Todo', category: 'todo', isDefaultForCategory: true },
  ],
  fieldMappings: [{ externalKey: 'labels', externalLabel: 'Labels', target: 'native:labels' }],
  identityByExternalUserId: new Map(),
})

const activityContext = (seeded: Seed, identities = new Map()): ActivitySourceContext => ({
  id: seeded.sourceId,
  organizationId: seeded.organizationId,
  projectId: seeded.projectId,
  provider: 'linear',
  identityByExternalUserId: identities,
})

const cleanup = async (prisma: PrismaClient, seeded: Seed): Promise<void> => {
  await prisma.attachment.deleteMany({ where: { organizationId: seeded.organizationId } })
  await prisma.organization.deleteMany({ where: { id: seeded.organizationId } })
  await prisma.user.deleteMany({ where: { id: seeded.userId } })
}

/** A file store that keeps nothing but a row, and says what it was handed. */
const standInFileService = (prisma: PrismaClient, seen: { stores: number }) =>
  ({
    store: async (input) => {
      seen.stores += 1
      let bytes = 0
      for await (const chunk of input.body) bytes += (chunk as Buffer).byteLength
      const attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          uploaderId: input.uploaderId,
          kind: 'image',
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(bytes),
          storageKey: `${input.organizationId}/${randomUUID()}`,
        },
      })
      return { attachment, bytesWritten: bytes }
    },
  }) as Pick<FileService, 'store'>

const connection = (seeded: Seed) => ({
  connectionId: 'connection',
  organizationId: seeded.organizationId,
  ownerUserId: seeded.ownerUserId,
  provider: 'linear' as const,
  externalAccountId: 'acct',
  externalTenantId: 'tenant',
  credential: { accessToken: 'token', scopes: [] },
})

test('comments and files do not move the item fingerprint', () => {
  const bare = item()
  const withActivity = item({
    comments: [comment()],
    attachments: [
      { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: bare.createdAt },
    ],
  })
  // Otherwise every new comment would re-apply the whole issue and a
  // write-back's echo would stop being recognised as our own.
  assert.equal(itemFingerprint(withActivity, ['labels']), itemFingerprint(bare, ['labels']))
})

runDatabaseTest('an unchanged item still has its comments applied', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    const again = await applyInboundItem(prisma, applyContext(seeded), item({ comments: [comment()] }))
    assert.equal(again.applied, 'unchanged')
    const touched = await applyInboundComments(prisma, activityContext(seeded), [comment()])
    assert.equal(touched.size, 1)
    assert.equal(await prisma.taskComment.count({ where: { sourceId: seeded.sourceId } }), 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a provider label adopts the Nessie label a person made with the same name', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const mine = await prisma.taskLabel.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        name: 'bug',
        normalizedName: 'bug',
        color: '#6b7280',
        createdByUserId: seeded.userId,
      },
    })
    await applyInboundItem(
      prisma,
      applyContext(seeded),
      item({ labels: [{ id: 'linear-bug', label: 'Bug', color: '#eb5757' }] }),
    )
    const labels = await prisma.taskLabel.findMany({ where: { projectId: seeded.projectId } })
    assert.equal(labels.length, 1, 'adopted, not duplicated')
    assert.equal(labels[0]?.id, mine.id)
    assert.equal(labels[0]?.sourceId, seeded.sourceId)
    assert.equal(labels[0]?.externalId, 'linear-bug')
    assert.equal(labels[0]?.color, '#eb5757')
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    const links = await prisma.taskLabelLink.findMany({ where: { taskId: task.id } })
    assert.deepEqual(links.map((link) => link.labelId), [mine.id])
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the sync replaces only the source-owned labels and keeps Nessie-only ones', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const context = applyContext(seeded)
    await applyInboundItem(
      prisma,
      context,
      item({
        labels: [
          { id: 'l-bug', label: 'Bug', color: '#eb5757' },
          { id: 'l-web', label: 'Web', color: '#4ea7fc' },
        ],
      }),
    )
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    const local = await prisma.taskLabel.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        name: 'Needs design',
        normalizedName: 'needs design',
      },
    })
    await prisma.taskLabelLink.create({ data: { taskId: task.id, labelId: local.id } })

    await applyInboundItem(
      prisma,
      context,
      item({
        updatedAt: '2026-09-05T00:00:00.000Z',
        labels: [
          { id: 'l-web', label: 'Web', color: '#4ea7fc' },
          { id: 'l-perf', label: 'Perf', color: '#f2c94c' },
        ],
      }),
    )
    const linked = await prisma.taskLabelLink.findMany({
      where: { taskId: task.id },
      include: { label: true },
    })
    assert.deepEqual(linked.map((link) => link.label.name).sort(), ['Needs design', 'Perf', 'Web'])
    const event = await prisma.taskEvent.findFirstOrThrow({
      where: { taskId: task.id, eventType: 'labels_changed' },
    })
    const payload = event.payload as { by: string; added: string[]; removed: string[] }
    assert.equal(payload.by, `source:${seeded.sourceId}`)
    assert.equal(payload.added.length, 1)
    assert.equal(payload.removed.length, 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('comments insert, update when newer, soft-delete on removal, and skip restricted', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    const source = activityContext(seeded)
    await applyInboundComments(prisma, source, [
      comment(),
      comment({ externalId: 'comment-bot', author: null, authorDisplay: 'GitHub', body: 'Linked PR' }),
      comment({ externalId: 'comment-secret', restricted: true, body: 'Internal only' }),
      comment({ externalId: 'comment-orphan', issueExternalId: 'issue-not-mirrored' }),
    ])
    const rows = await prisma.taskComment.findMany({
      where: { sourceId: seeded.sourceId },
      orderBy: { externalId: 'asc' },
    })
    assert.deepEqual(rows.map((row) => row.externalId), ['comment-1', 'comment-bot'])
    const human = rows.find((row) => row.externalId === 'comment-1')
    assert.equal(human?.authorUserId, null)
    assert.equal(human?.externalAuthorExternalId, 'linear-alice')
    assert.equal(human?.externalAuthorDisplay, 'Alice Upstream')
    assert.equal(human?.createdAt.toISOString(), '2026-09-03T00:00:00.000Z')
    assert.equal(rows.find((row) => row.externalId === 'comment-bot')?.externalAuthorDisplay, 'GitHub')

    // Re-applying the same page is a no-op; an older copy never overwrites.
    await applyInboundComments(prisma, source, [comment({ body: 'Stale' })])
    assert.equal((await prisma.taskComment.findUniqueOrThrow({ where: { id: human!.id } })).body, 'First')

    await applyInboundComments(prisma, source, [
      comment({ body: 'Edited upstream', updatedAt: '2026-09-04T00:00:00.000Z', editedAt: '2026-09-04T00:00:00.000Z' }),
    ])
    const edited = await prisma.taskComment.findUniqueOrThrow({ where: { id: human!.id } })
    assert.equal(edited.body, 'Edited upstream')
    assert.equal(edited.editedAt?.toISOString(), '2026-09-04T00:00:00.000Z')

    await removeInboundComments(prisma, source, ['comment-1'])
    const removed = await prisma.taskComment.findUniqueOrThrow({ where: { id: human!.id } })
    assert.ok(removed.deletedAt)
    assert.equal(removed.body, '')
    // Deleted stays deleted: a later poll that still sees it does not revive it.
    await applyInboundComments(prisma, source, [
      comment({ body: 'Back?', updatedAt: '2026-09-06T00:00:00.000Z' }),
    ])
    assert.ok((await prisma.taskComment.findUniqueOrThrow({ where: { id: human!.id } })).deletedAt)

    const kinds = (await prisma.taskEvent.findMany({ where: { task: { projectId: seeded.projectId } } }))
      .map((event) => event.eventType)
    assert.equal(kinds.filter((kind) => kind === 'comment_added').length, 2)
    assert.equal(kinds.filter((kind) => kind === 'comment_edited').length, 1)
    assert.equal(kinds.filter((kind) => kind === 'comment_deleted').length, 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a mapping made later re-attributes the comments that provider user wrote', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    await applyInboundComments(prisma, activityContext(seeded), [comment()])
    const connectionRow = await prisma.boardSourceConnection.findFirstOrThrow({
      where: { organizationId: seeded.organizationId },
    })
    await reprojectIdentityLinks(
      prisma,
      { organizationId: seeded.organizationId, provider: 'linear', externalTenantKey: connectionRow.externalTenantId },
      [{ externalUserId: 'linear-alice', displayName: 'Alice Upstream', email: null, userId: seeded.userId, agentId: null }],
    )
    const row = await prisma.taskComment.findFirstOrThrow({ where: { sourceId: seeded.sourceId } })
    assert.equal(row.authorUserId, seeded.userId)
    // A person's name is never stored once we know who they are.
    assert.equal(row.externalAuthorDisplay, null)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a pending image is stored and its URL rewritten in the description and a comment', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    const source = activityContext(seeded)
    await applyInboundComments(prisma, source, [comment({ body: `See ![](${SHOT}) and ![](${CLIP})` })])
    await applyInboundAssets(prisma, source, [
      { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: '2026-09-01T00:00:00.000Z' },
      { issueExternalId: 'issue-1', commentExternalId: 'comment-1', url: CLIP, title: 'clip.gif', kind: 'file', inline: true, createdAt: '2026-09-03T00:00:00.000Z' },
      { issueExternalId: 'issue-1', url: 'https://github.com/acme/x/pull/1', title: 'PR', kind: 'link', createdAt: '2026-09-01T00:00:00.000Z' },
    ])
    const before = await prisma.taskExternalAsset.findMany({ where: { sourceId: seeded.sourceId } })
    assert.deepEqual(
      before.map((asset) => `${asset.kind}:${asset.status}`).sort(),
      ['inline_image:pending', 'inline_image:pending', 'link:link'],
    )

    const seen = { stores: 0 }
    await fetchPendingAssets(prisma, {
      source,
      adapter: {
        fetchAsset: async (): Promise<AssetStream> => ({
          stream: Readable.from([Buffer.from('png-bytes')]),
          contentType: 'image/png',
          sizeBytes: 9,
        }),
      },
      context: connection(seeded),
      fileService: standInFileService(prisma, seen),
    })
    assert.equal(seen.stores, 2)

    const shot = await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: SHOT } })
    const clip = await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: CLIP } })
    assert.equal(shot.status, 'stored')
    assert.ok(shot.attachmentId)
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    assert.equal(task.detail, `Broken: ![shot](/api/attachments/${shot.attachmentId})`)
    const body = (await prisma.taskComment.findFirstOrThrow({ where: { sourceId: seeded.sourceId } })).body
    assert.equal(body, `See ![](/api/attachments/${shot.attachmentId}) and ![](/api/attachments/${clip.attachmentId})`)

    const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: clip.attachmentId! } })
    assert.equal(stored.taskId, task.id)
    assert.ok(stored.taskCommentId, 'a comment’s image is linked to the comment too')
    assert.equal(stored.uploaderId, null)

    // The next changed item writes the provider's description again; the
    // stored image must not flip back to the provider URL.
    await applyInboundItem(prisma, applyContext(seeded), item({ title: 'Retitled', updatedAt: '2026-09-09T00:00:00.000Z' }))
    const reapplied = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    assert.equal(reapplied.detail, `Broken: ![shot](/api/attachments/${shot.attachmentId})`)

    // Re-applying the same attachments is idempotent by (sourceId, url).
    await applyInboundAssets(prisma, source, [
      { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: '2026-09-01T00:00:00.000Z' },
    ])
    assert.equal(await prisma.taskExternalAsset.count({ where: { sourceId: seeded.sourceId } }), 3)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('three failed fetches mark the file failed and leave the text alone', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    const source = activityContext(seeded)
    await applyInboundAssets(prisma, source, [
      { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: '2026-09-01T00:00:00.000Z' },
    ])
    const seen = { stores: 0 }
    const run = () =>
      fetchPendingAssets(prisma, {
        source,
        adapter: {
          fetchAsset: async () => {
            throw new SourceHttpError(500, 'upstream down')
          },
        },
        context: connection(seeded),
        fileService: standInFileService(prisma, seen),
      })

    await run()
    let asset = await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: SHOT } })
    assert.equal(asset.status, 'pending')
    assert.equal(asset.attempts, 1)
    assert.equal(asset.lastError, 'ASSET_HTTP_500')
    await run()
    await run()
    asset = await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: SHOT } })
    assert.equal(asset.status, 'failed')
    assert.equal(asset.attempts, 3)
    assert.equal(asset.attachmentId, null)
    // A failed row is not re-listed.
    await run()
    assert.equal((await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: SHOT } })).attempts, 3)
    assert.equal(seen.stores, 0)
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: seeded.projectId } })
    assert.equal(task.detail, `Broken: ![shot](${SHOT})`)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a 26 MiB provider file is refused before the store and fails at once', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await applyInboundItem(prisma, applyContext(seeded), item())
    const source = activityContext(seeded)
    await applyInboundAssets(prisma, source, [
      { issueExternalId: 'issue-1', url: SHOT, title: null, kind: 'file', inline: true, createdAt: '2026-09-01T00:00:00.000Z' },
    ])
    const seen = { stores: 0 }
    await fetchPendingAssets(prisma, {
      source,
      adapter: {
        // The adapter's real path: the provider's response through the
        // streaming envelope, which reads the declared length first.
        fetchAsset: async () =>
          streamFromSourceResponse(
            new Response(new Uint8Array(16), {
              status: 200,
              headers: { 'content-length': String(26 * MIB), 'content-type': 'image/png' },
            }),
          ),
      },
      context: connection(seeded),
      fileService: standInFileService(prisma, seen),
    })
    assert.equal(seen.stores, 0, 'the store was never handed the stream')
    const asset = await prisma.taskExternalAsset.findFirstOrThrow({ where: { externalUrl: SHOT } })
    assert.equal(asset.status, 'failed')
    assert.equal(asset.lastError, 'ASSET_TOO_LARGE')
    assert.equal(asset.attempts, 1)
  } finally {
    await cleanup(prisma, seeded)
    await prisma.$disconnect()
  }
})
