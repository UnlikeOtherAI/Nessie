import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'

import {
  buildTransferApp,
  seedTransferWorld,
  teardownTransferWorld,
  transferAs,
  type TransferSeed,
} from './knowledge-transfers-support.js'

/**
 * The refusals that stay (transfer.md §4), and the one property they share:
 * **a refused transfer leaves nothing behind.** Every case here asserts the
 * code and the sentence, and then that the page is still exactly where it was —
 * a refusal that had already rewritten half a subtree would be worse than no
 * refusal at all.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const page = async (
  seeded: TransferSeed,
  input: { spaceId: string; title: string; taskId?: string | null },
): Promise<string> => {
  const created = await createNativeKnowledgeProvider(seeded.prisma).createPage({
    organizationId: seeded.organizationId,
    spaceId: input.spaceId,
    title: input.title,
    body: `<p>${input.title}</p>`,
    authorId: seeded.ownerId,
    authorType: 'user',
    createdBy: seeded.ownerId,
    taskId: input.taskId ?? null,
  })
  return created.id
}

const errorOf = (response: { json: () => unknown }): { code: string; message: string } =>
  (response.json() as { error: { code: string; message: string } }).error

const stillIn = async (
  seeded: TransferSeed,
  pageId: string,
  spaceId: string,
): Promise<void> => {
  const row = await seeded.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
  assert.equal(row.spaceId, spaceId, 'a refused transfer must not move anything')
  assert.equal(row.revision, 0, 'a refused transfer must not bump the revision either')
}

dbTest('a transfer without an acknowledgement is refused by name', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const pageId = await page(seeded, { spaceId: seeded.personalSpaceId, title: 'Plan' })
    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(errorOf(response).code, 'TRANSFER_NOT_ACKNOWLEDGED')
    await stillIn(seeded, pageId, seeded.personalSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('a target the caller cannot write is refused with its own sentence', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    // The outsider's own personal root folder is readable and writable by them;
    // the owner's is not.
    const theirSpace = await seeded.prisma.knowledgeSpace.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        name: 'Their Documents',
        createdBy: seeded.outsiderId,
        visibility: 'private',
        userId: seeded.outsiderId,
      },
      select: { id: true },
    })
    const pageId = await page(seeded, { spaceId: seeded.orgSpaceId, title: 'Brochure' })

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: theirSpace.id, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(errorOf(response), {
      code: 'TRANSFER_TARGET_NOT_WRITABLE',
      message: "You can't add items to Their Documents.",
    })
    await stillIn(seeded, pageId, seeded.orgSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('a target inside the moved folder is refused', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const folderId = await page(seeded, { spaceId: seeded.personalSpaceId, title: 'Contracts' })
    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [folderId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: folderId },
      acknowledged: true,
    })
    // The parent is in the source space, so it is not a target-space parent at
    // all — the transfer is refused before it can rewrite anything.
    assert.equal(response.statusCode, 404)
    await stillIn(seeded, folderId, seeded.personalSpaceId)

    const sameRoot = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [folderId],
      target: { spaceId: seeded.personalSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(sameRoot.statusCode, 400)
    assert.equal(errorOf(sameRoot).code, 'TRANSFER_INTO_SELF')
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest("an agent's active instructions stay with the agent", async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const agent = await seeded.prisma.agent.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        teamId: seeded.teamId,
        name: 'Scribe',
      },
      select: { id: true },
    })
    const pageId = await page(seeded, { spaceId: seeded.personalSpaceId, title: 'Persona' })
    await seeded.prisma.agentCoreDocument.create({
      data: { agentId: agent.id, pageId, role: 'identity' },
    })

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(errorOf(response), {
      code: 'TRANSFER_AGENT_CORE_DOCUMENT',
      message: '“Persona” is Scribe\'s active instructions and stays with the agent.',
    })
    await stillIn(seeded, pageId, seeded.personalSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest("a ticket's documents cannot leave the ticket's project", async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const task = await seeded.prisma.task.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        purpose: 'Ship the thing',
      },
      select: { id: true },
    })
    const otherProjectSpace = await seeded.prisma.knowledgeSpace.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.otherProjectId,
        name: 'Legal Documents',
        createdBy: seeded.ownerId,
        visibility: 'organization',
      },
      select: { id: true },
    })
    const pageId = await page(seeded, {
      spaceId: seeded.projectSpaceId,
      title: 'Ticket notes',
      taskId: task.id,
    })

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: otherProjectSpace.id, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(errorOf(response), {
      code: 'TRANSFER_TASK_BOUND',
      message: '“Ticket notes” belongs to a ticket in Marketing and can\'t leave that project.',
    })
    await stillIn(seeded, pageId, seeded.projectSpaceId)

    // The same page moves freely inside its own project's root folders.
    const sameProject = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.orgSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(sameProject.statusCode, 200)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('material based on a private channel cannot widen to the organisation', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const pageId = await page(seeded, { spaceId: seeded.personalSpaceId, title: 'Digest' })
    const version = await seeded.prisma.knowledgePageVersion.findFirstOrThrow({
      where: { pageId },
      select: { id: true },
    })
    // Written directly: a basis row is provenance an agent's write leaves, and
    // the rule this tests is a predicate over exactly these columns.
    await seeded.prisma.$executeRaw(Prisma.sql`
      INSERT INTO knowledge_page_version_basis_scopes
        (version_id, organization_id, scope_type, scope_id)
      VALUES (${version.id}::uuid, ${seeded.organizationId}::uuid, 'channel',
              ${seeded.channelId}::uuid)
    `)

    const widened = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.orgSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(widened.statusCode, 403)
    assert.deepEqual(errorOf(widened), {
      code: 'TRANSFER_WIDENS_BASIS',
      message: '“Digest” contains material that not everyone in Everyone may see.',
    })
    await stillIn(seeded, pageId, seeded.personalSpaceId)
    // Nothing was written on the way to the refusal.
    assert.equal(
      await seeded.prisma.knowledgePage.count({ where: { spaceId: seeded.orgSpaceId } }),
      0,
    )

    // A copy is judged by the same rule: provenance travels with content, so a
    // copy cannot launder it either.
    const copied = await transferAs(app, 'owner', {
      operation: 'copy',
      pageIds: [pageId],
      target: { spaceId: seeded.orgSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(copied.statusCode, 403)
    assert.equal(errorOf(copied).code, 'TRANSFER_WIDENS_BASIS')
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('a personal-basis page may come back to that person\'s own folder', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const pageId = await page(seeded, { spaceId: seeded.projectSpaceId, title: 'Notes' })
    const version = await seeded.prisma.knowledgePageVersion.findFirstOrThrow({
      where: { pageId },
      select: { id: true },
    })
    await seeded.prisma.$executeRaw(Prisma.sql`
      INSERT INTO knowledge_page_version_basis_scopes
        (version_id, organization_id, scope_type, scope_id)
      VALUES (${version.id}::uuid, ${seeded.organizationId}::uuid, 'user', ${seeded.ownerId}::uuid)
    `)

    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [pageId],
      target: { spaceId: seeded.personalSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 200)
    const row = await seeded.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
    assert.equal(row.spaceId, seeded.personalSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('pages from two root folders at once are refused', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const here = await page(seeded, { spaceId: seeded.personalSpaceId, title: 'Here' })
    const there = await page(seeded, { spaceId: seeded.projectSpaceId, title: 'There' })
    const response = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [here, there],
      target: { spaceId: seeded.orgSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(response.statusCode, 400)
    assert.equal(errorOf(response).code, 'TRANSFER_MIXED_SOURCES')
    await stillIn(seeded, here, seeded.personalSpaceId)
    await stillIn(seeded, there, seeded.projectSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('the status of another tenant\'s transfer is indistinguishable from none', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    const transferId = randomUUID()
    await seeded.prisma.$executeRaw(Prisma.sql`
      INSERT INTO queue_jobs (topic, payload, status, attempt, max_attempts, idempotency_key)
      VALUES ('knowledge.transfer',
              ${JSON.stringify({ organizationId: randomUUID(), operation: 'move' })}::jsonb,
              'processing', 0, 1, ${`kb-transfer:${transferId}`})
    `)
    const response = await app.inject({
      method: 'GET',
      url: `/api/knowledge-base/transfers/${transferId}`,
      headers: { 'x-transfer-actor': 'owner' },
    })
    assert.equal(response.statusCode, 404)
    assert.equal(errorOf(response).code, 'TRANSFER_NOT_FOUND')
    await seeded.prisma.$executeRaw(Prisma.sql`
      DELETE FROM queue_jobs WHERE idempotency_key = ${`kb-transfer:${transferId}`}
    `)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})

dbTest('a spreadsheet moves but is refused a copy, with nothing written', async () => {
  const seeded = await seedTransferWorld()
  const app = buildTransferApp(seeded)
  try {
    // Only the row matters here: what makes a page a workbook is its
    // `SpreadsheetHead`, and the point of the refusal is that
    // `planTransferCopy` does not write one.
    const workbook = await seeded.prisma.knowledgePage.create({
      data: {
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        spaceId: seeded.personalSpaceId,
        title: 'Runway',
        kind: 'spreadsheet',
        createdBy: seeded.ownerId,
      },
      select: { id: true },
    })

    const copied = await transferAs(app, 'owner', {
      operation: 'copy',
      pageIds: [workbook.id],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(copied.statusCode, 400)
    assert.deepEqual(errorOf(copied), {
      code: 'TRANSFER_COPY_SPREADSHEET',
      message: '“Runway” is a spreadsheet and can be moved, but not copied yet.',
    })
    // Nothing behind: no second page, and therefore no page claiming to be a
    // workbook with no head under it.
    assert.equal(
      await seeded.prisma.knowledgePage.count({
        where: { organizationId: seeded.organizationId, kind: 'spreadsheet' },
      }),
      1,
    )

    // A move keeps the page id, so the head, the journal and the filters follow
    // it — that arm stays open.
    const moved = await transferAs(app, 'owner', {
      operation: 'move',
      pageIds: [workbook.id],
      target: { spaceId: seeded.projectSpaceId, parentPageId: null },
      acknowledged: true,
    })
    assert.equal(moved.statusCode, 200, moved.body)
    const row = await seeded.prisma.knowledgePage.findUniqueOrThrow({
      where: { id: workbook.id },
    })
    assert.equal(row.spaceId, seeded.projectSpaceId)
  } finally {
    await app.close()
    await teardownTransferWorld(seeded)
  }
})
