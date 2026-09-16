import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createNativeKnowledgeProvider } from '@nessie/knowledge'

import {
  buildTransferApp,
  chunkScopes,
  seedTransferWorld,
  teardownTransferWorld,
  transferAs,
  type TransferSeed,
} from './knowledge-transfers-support.js'

/**
 * Moving and copying between root folders, against real rows.
 *
 * The assertion this suite exists for is the chunk mirror. Retrieval filters on
 * `knowledge_page_chunks`' own scope columns so it never has to join back
 * through mutable page metadata — so a chunk left on the old scope keeps
 * answering the **old** audience, and a document moved out of a personal folder
 * would still be findable, by passage, to the people it was moved away from.
 * `move rewrites the chunk mirrors…` below is that test: it runs the predicate
 * retrieval runs, both ways round.
 *
 * Everything here needs Postgres. A cast Prisma fake would be asserting on its
 * own arithmetic — the ledger balance and the chunk scopes are sums and
 * predicates over real columns.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const publishedPage = async (
  seeded: TransferSeed,
  input: { spaceId: string; title: string; body: string; parentPageId?: string | null },
): Promise<string> => {
  const provider = createNativeKnowledgeProvider(seeded.prisma)
  const page = await provider.createPage({
    organizationId: seeded.organizationId,
    spaceId: input.spaceId,
    title: input.title,
    body: input.body,
    authorId: seeded.ownerId,
    authorType: 'user',
    createdBy: seeded.ownerId,
    parentPageId: input.parentPageId ?? null,
  })
  await provider.publishPage({ organizationId: seeded.organizationId, pageId: page.id })
  return page.id
}

const organizationUsage = async (seeded: TransferSeed): Promise<bigint> => {
  const sum = await seeded.prisma.storageUsageEvent.aggregate({
    _sum: { deltaBytes: true },
    where: { organizationId: seeded.organizationId },
  })
  return sum._sum.deltaBytes ?? 0n
}

const spaceUsage = async (seeded: TransferSeed, spaceId: string): Promise<bigint> => {
  const sum = await seeded.prisma.storageUsageEvent.aggregate({
    _sum: { deltaBytes: true },
    where: { organizationId: seeded.organizationId, spaceId },
  })
  return sum._sum.deltaBytes ?? 0n
}

dbTest('move rewrites the pages, the chunk mirrors and the annotations together', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const pageId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Plan',
      body: '<p>The quarterly plan, written privately and at some length so that it chunks.</p>',
    })
    await seeded.prisma.knowledgePageAnnotation.create({
      data: {
        pageId,
        spaceId: seeded.personalSpaceId,
        organizationId: seeded.organizationId,
        kind: 'comment',
        body: 'A note to self',
        authorType: 'user',
        authorId: seeded.ownerId,
      },
    })
    const before = await chunkScopes(seeded, pageId)
    assert.ok(before.length > 0, 'the page must be indexed before it is moved')
    assert.equal(before[0]?.space_visibility, 'private')

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as {
      data: {
        status: string
        operation: string
        pages: Array<{ sourcePageId: string; pageId: string }>
        descendants: number
        sharesEnded: number
      }
    }
    assert.equal(body.data.status, 'done')
    assert.equal(body.data.operation, 'move')
    assert.deepEqual(body.data.pages, [{ sourcePageId: pageId, pageId }])
    assert.equal(body.data.descendants, 0)

    const moved = await seeded.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
    assert.equal(moved.spaceId, seeded.projectSpaceId)
    assert.equal(moved.visibility, 'project')
    assert.equal(moved.userId, null)
    assert.equal(moved.revision, 1)

    // THE assertion. Run exactly as retrieval filters: the old audience's
    // predicate must now match nothing, and the new one must match every chunk.
    const stillVisibleToTheOldAudience = await seeded.prisma.knowledgePageChunk.count({
      where: { pageId, visibility: 'private', userId: seeded.ownerId },
    })
    assert.equal(
      stillVisibleToTheOldAudience,
      0,
      'a chunk left on the old scope keeps answering the audience the page just left',
    )
    const after = await chunkScopes(seeded, pageId)
    assert.equal(after.length, before.length)
    for (const chunk of after) {
      assert.equal(chunk.space_visibility, 'project')
      assert.equal(chunk.project_id, seeded.projectId)
      assert.equal(chunk.user_id, null)
    }

    // The annotation's denormalised space_id travels in the same transaction.
    const annotation = await seeded.prisma.knowledgePageAnnotation.findFirstOrThrow({
      where: { pageId },
    })
    assert.equal(annotation.spaceId, seeded.projectSpaceId)

    const audit = await seeded.prisma.auditLog.findFirst({
      where: { resourceId: pageId, action: 'kb.page.moved' },
    })
    assert.ok(audit, 'a move records one kb.page.moved per selected root')
    const metadata = audit.metadata as Record<string, unknown>
    assert.equal(metadata['fromSpaceId'], seeded.personalSpaceId)
    assert.equal(metadata['toSpaceId'], seeded.projectSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('move carries a folder\'s children and re-homes their bytes at zero net cost', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const folderId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Contracts',
      body: '<p>Contracts folder overview.</p>',
    })
    const childId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Lease',
      body: '<p>The lease itself, with enough words in it to produce a chunk row.</p>',
      parentPageId: folderId,
    })
    const stored = await seeded.fileService.store({
      attribution: {
        organizationId: seeded.organizationId,
        actorId: seeded.ownerId,
        actorType: 'user',
        userId: seeded.ownerId,
      },
      organizationId: seeded.organizationId,
      uploaderId: seeded.ownerId,
      filename: 'lease.pdf',
      mime: 'application/pdf',
      body: Readable.from(Buffer.from('lease bytes'.repeat(32))),
      knowledgePageId: childId,
      scope: {
        projectId: seeded.projectId,
        teamId: seeded.teamId,
        spaceId: seeded.personalSpaceId,
      },
    })

    const organizationBefore = await organizationUsage(seeded)
    assert.equal(await spaceUsage(seeded, seeded.personalSpaceId), BigInt(stored.bytesWritten))

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [folderId],
      target: { spaceId: seeded.orgSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 200)
    assert.equal((response.json() as { data: { descendants: number } }).data.descendants, 1)

    const child = await seeded.prisma.knowledgePage.findUniqueOrThrow({ where: { id: childId } })
    assert.equal(child.spaceId, seeded.orgSpaceId)
    assert.equal(child.parentPageId, folderId, 'a descendant keeps the parent it had')
    assert.equal(child.visibility, 'organization')
    for (const chunk of await chunkScopes(seeded, childId)) {
      assert.equal(chunk.space_visibility, 'organization')
    }

    // The ledger is true: the bytes left one space, arrived in the other, and
    // the organisation total did not move — which is why a move runs no quota
    // check at all.
    assert.equal(await spaceUsage(seeded, seeded.personalSpaceId), 0n)
    assert.equal(await spaceUsage(seeded, seeded.orgSpaceId), BigInt(stored.bytesWritten))
    assert.equal(await organizationUsage(seeded), organizationBefore)
    const pair = await seeded.prisma.storageUsageEvent.findMany({
      where: { attachmentId: stored.attachment.id, operation: { in: ['move.out', 'move.in'] } },
      select: { operation: true, spaceId: true, deltaBytes: true },
    })
    assert.equal(pair.length, 2)
    assert.equal(pair.reduce((total, row) => total + row.deltaBytes, 0n), 0n)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('move out of a personal folder ends every share on the subtree', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const pageId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Ideas',
      body: '<p>Ideas worth sharing with exactly one person.</p>',
    })
    await seeded.prisma.knowledgePageShare.create({
      data: {
        organizationId: seeded.organizationId,
        pageId,
        spaceId: seeded.personalSpaceId,
        granteeUserId: seeded.outsiderId,
        grantedByUserId: seeded.ownerId,
        access: 'view',
      },
    })

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 200)
    assert.equal((response.json() as { data: { sharesEnded: number } }).data.sharesEnded, 1)
    assert.equal(await seeded.prisma.knowledgePageShare.count({ where: { pageId } }), 0)

    const audit = await seeded.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: pageId, action: 'kb.page.moved' },
    })
    const ended = (audit.metadata as Record<string, unknown>)['endedShares']
    assert.deepEqual(ended, [{
      granteeUserId: seeded.outsiderId,
      spaceId: seeded.personalSpaceId,
      by: 'moved',
    }])
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('copy makes a new document with one version and its own bytes', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const folderId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Contracts',
      body: '<p>Contracts folder overview.</p>',
    })
    const childId = await publishedPage(seeded, {
      spaceId: seeded.personalSpaceId,
      title: 'Lease',
      body: '<p>The lease itself, long enough to chunk when it is published.</p>',
      parentPageId: folderId,
    })
    await seeded.prisma.knowledgePageShare.create({
      data: {
        organizationId: seeded.organizationId,
        pageId: childId,
        spaceId: seeded.personalSpaceId,
        granteeUserId: seeded.outsiderId,
        grantedByUserId: seeded.ownerId,
        access: 'view',
      },
    })
    const stored = await seeded.fileService.store({
      attribution: {
        organizationId: seeded.organizationId,
        actorId: seeded.ownerId,
        actorType: 'user',
        userId: seeded.ownerId,
      },
      organizationId: seeded.organizationId,
      uploaderId: seeded.ownerId,
      filename: 'lease.pdf',
      mime: 'application/pdf',
      body: Readable.from(Buffer.from('lease bytes'.repeat(16))),
      knowledgePageId: childId,
      scope: {
        projectId: seeded.projectId,
        teamId: seeded.teamId,
        spaceId: seeded.personalSpaceId,
      },
    })

    const response = await transferAs(app, 'owner', {
      operation: 'copy',
      pageIds: [folderId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as {
      data: { operation: string; pages: Array<{ sourcePageId: string; pageId: string }> }
    }
    assert.equal(body.data.operation, 'copy')
    const copyId = body.data.pages[0]?.pageId as string
    assert.notEqual(copyId, folderId)

    // The source is untouched, including its share.
    const source = await seeded.prisma.knowledgePage.findUniqueOrThrow({ where: { id: folderId } })
    assert.equal(source.spaceId, seeded.personalSpaceId)
    assert.equal(await seeded.prisma.knowledgePageShare.count({ where: { pageId: childId } }), 1)

    const copiedChild = await seeded.prisma.knowledgePage.findFirstOrThrow({
      where: { spaceId: seeded.projectSpaceId, title: 'Lease' },
      include: { versions: true },
    })
    assert.equal(copiedChild.parentPageId, copyId, 'the id map re-parents the children')
    assert.equal(copiedChild.visibility, 'project')
    assert.equal(copiedChild.taskId, null)
    assert.equal(copiedChild.documentRole, 'knowledge')
    assert.equal(copiedChild.versions.length, 1, 'a copy carries the current version only')
    assert.equal(copiedChild.versions[0]?.versionNumber, 1)
    assert.equal(copiedChild.versions[0]?.changeComment, 'Copied from My Documents')
    assert.equal(copiedChild.versions[0]?.authorId, seeded.ownerId)
    assert.equal(copiedChild.publishedVersionId, copiedChild.versions[0]?.id)

    // No share, no annotation, and chunks that were generated fresh in the
    // destination's scope rather than copied out of the source's.
    assert.equal(
      await seeded.prisma.knowledgePageShare.count({ where: { pageId: copiedChild.id } }),
      0,
    )
    for (const chunk of await chunkScopes(seeded, copiedChild.id)) {
      assert.equal(chunk.space_visibility, 'project')
      assert.equal(chunk.project_id, seeded.projectId)
    }

    // Bytes are re-stored, never referenced: a new row, a new key, and the
    // destination charged for them.
    const copiedAttachment = await seeded.prisma.attachment.findFirstOrThrow({
      where: { knowledgePageId: copiedChild.id },
    })
    assert.notEqual(copiedAttachment.id, stored.attachment.id)
    assert.notEqual(copiedAttachment.storageKey, stored.attachment.storageKey)
    assert.equal(copiedAttachment.sizeBytes, stored.attachment.sizeBytes)
    assert.equal(
      await spaceUsage(seeded, seeded.projectSpaceId),
      BigInt(stored.bytesWritten),
    )
    assert.equal(
      await spaceUsage(seeded, seeded.personalSpaceId),
      BigInt(stored.bytesWritten),
      'the source keeps its own bytes',
    )

    const audit = await seeded.prisma.auditLog.findFirst({
      where: { resourceId: copiedChild.id, action: 'kb.page.created' },
    })
    assert.equal((audit?.metadata as Record<string, unknown>)['copiedFromPageId'], childId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})
