import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { KnowledgeVirtualRowSchema } from '@nessie/schemas'

import { createNativeKnowledgeProvider } from '../src/native-provider.js'
import { indexingStatesFor } from '../src/native-indexing-status.js'
import { listNativeLatestPages } from '../src/native-latest-pages.js'
import { pageRowFactsFor } from '../src/native-list-enrichment.js'
import { createSpreadsheetSnapshot } from '../src/spreadsheet/snapshot.js'
import { createSpreadsheetPage } from '../src/spreadsheet/create.js'
import { applySpreadsheetBatch } from '../src/spreadsheet/apply.js'
import { createEmptyWorkbook } from '../src/spreadsheet/engine.js'
import type { SpaceViewer } from '../src/access.js'
import {
  attributionFor,
  createTestService,
  dbAvailable,
  seedSpreadsheetFixture,
  userActor,
  type SpreadsheetSeed,
} from './spreadsheet-support.ts'

const dbTest = dbAvailable ? test : test.skip

/**
 * A spreadsheet is a page in the documents world the Finder refactor built:
 * it lives in folders, it appears in listings, and it is indexed.
 *
 * The refactor landed after the spreadsheet work was written, so each of these
 * is a place where the kind could have been left out without anything failing
 * to compile.
 */

const diffsFor = (client: ReturnType<typeof createEmptyWorkbook>, edit: () => void): Buffer => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue())
}

/** A spreadsheet with one durable version, which is what makes it searchable. */
const savedSpreadsheet = async (
  seed: SpreadsheetSeed,
  service: ReturnType<typeof createTestService>,
  input: { title: string; parentPageId?: string | null },
): Promise<string> => {
  const page = await createSpreadsheetPage(service, {
    organizationId: seed.organizationId,
    spaceId: seed.spaceId,
    projectId: seed.projectId,
    title: input.title,
    parentPageId: input.parentPageId ?? null,
    authorId: seed.userId,
    authorType: 'user',
    createdBy: seed.userId,
  })
  const client = createEmptyWorkbook('Sheet1')
  await applySpreadsheetBatch(
    service,
    {
      organizationId: seed.organizationId,
      pageId: page.id,
      clientOpId: randomUUID(),
      actor: userActor(seed),
      attribution: attributionFor(seed),
      source: {
        kind: 'client',
        diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'revenue')),
        baseSeq: 0,
      },
    },
    { structuralKind: null, sheetIndexes: [0], cellCount: 1, touched: [] },
  )
  await createSpreadsheetSnapshot(service, {
    organizationId: seed.organizationId,
    pageId: page.id,
    actor: userActor(seed),
    attribution: attributionFor(seed),
    reason: 'named',
    changeComment: 'first save',
  })
  return page.id
}

dbTest('a saved spreadsheet reports the indexing state its chunks actually have', async () => {
  const seed = await seedSpreadsheetFixture('sheet-indexing')
  const service = createTestService(seed)
  try {
    const provider = createNativeKnowledgeProvider(seed.prisma)
    const folder = await provider.createPage({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      spaceId: seed.spaceId,
      title: 'Models',
      kind: 'folder',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const fresh = await createSpreadsheetPage(service, {
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
      projectId: seed.projectId,
      title: 'Never saved',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const savedId = await savedSpreadsheet(seed, service, {
      title: 'Runway',
      parentPageId: folder.id,
    })

    const pages = await seed.prisma.knowledgePage.findMany({
      where: { id: { in: [folder.id, fresh.id, savedId] } },
      select: { id: true, kind: true, status: true, publishedVersionId: true },
    })
    const states = await indexingStatesFor(seed.prisma, pages)

    assert.deepEqual(states.get(folder.id), { state: 'not_applicable' })
    assert.deepEqual(
      states.get(fresh.id),
      { state: 'not_indexed', reason: 'empty' },
      'the first durable version is deferred to the first snapshot, so there is genuinely no text yet',
    )

    const saved = states.get(savedId)
    assert.ok(saved, 'a saved spreadsheet has a state')
    // The chunks exist and are waiting on their embeddings. What matters is
    // that it is neither of the two answers the sibling arms would have given:
    // `fileState` would call the `.xlsx` rendition unsupported, and
    // `documentState` would call a page nothing ever publishes a draft.
    assert.equal(saved.state, 'pending', JSON.stringify(saved))
    assert.equal(saved.state === 'pending' ? saved.stage : null, 'embed')
    const chunks = await seed.prisma.knowledgePageChunk.count({ where: { pageId: savedId } })
    assert.ok(chunks > 0, 'the save wrote the chunks the state is reporting on')
  } finally {
    await service.shutdown?.()
    await seed.teardown()
  }
})

dbTest('a spreadsheet survives the Latest listing it used to break', async () => {
  const seed = await seedSpreadsheetFixture('sheet-latest')
  const service = createTestService(seed)
  try {
    const pageId = await savedSpreadsheet(seed, service, { title: 'Runway' })
    const viewer = {
      baseEntitled: true,
      bypass: true,
      organizationRole: 'owner',
      uoaMembershipVerified: false,
      userId: seed.userId,
      projectIds: new Set<string>(),
      visibleAgentIds: new Set<string>(),
    } as SpaceViewer

    const listed = await listNativeLatestPages(seed.prisma, {
      organizationId: seed.organizationId,
      viewer,
    })
    const row = listed.data.find((candidate) => candidate.id === pageId)
    assert.ok(row, 'a spreadsheet is a change somebody made, so Latest carries it')
    assert.equal(row.kind, 'spreadsheet')
    // The regression: the row type said `'document' | 'file'` while the query
    // excluded only folders, so this parse threw and took the whole listing
    // with it.
    assert.doesNotThrow(() => KnowledgeVirtualRowSchema.parse(row))

    // Its size is the `.xlsx` rendition, which is what a reader downloads.
    const facts = await pageRowFactsFor(seed.prisma, [{ id: pageId, kind: 'spreadsheet' }])
    const version = await seed.prisma.knowledgePageVersion.findFirstOrThrow({
      where: { pageId },
      orderBy: { versionNumber: 'desc' },
    })
    const attachment = await seed.prisma.attachment.findUniqueOrThrow({
      where: { id: version.attachmentId as string },
    })
    assert.equal(facts.get(pageId)?.sizeBytes, attachment.sizeBytes.toString())
    assert.equal(facts.get(pageId)?.mime, null, 'a spreadsheet is not a file node')
  } finally {
    await service.shutdown?.()
    await seed.teardown()
  }
})

dbTest('a spreadsheet moves into a folder and can never be one', async () => {
  const seed = await seedSpreadsheetFixture('sheet-move')
  const service = createTestService(seed)
  try {
    const provider = createNativeKnowledgeProvider(seed.prisma)
    const folder = await provider.createPage({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      spaceId: seed.spaceId,
      title: 'Models',
      kind: 'folder',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const pageId = await savedSpreadsheet(seed, service, { title: 'Runway' })

    const moved = await provider.movePage({
      organizationId: seed.organizationId,
      pageId,
      parentPageId: folder.id,
      position: 0,
    })
    assert.equal(moved?.parentPageId, folder.id)

    // A folder's children listing is the same query for every kind.
    const children = await provider.listPages({
      organizationId: seed.organizationId,
      spaceId: seed.spaceId,
    })
    assert.deepEqual(
      children.filter((page) => page.parentPageId === folder.id).map((page) => page.kind),
      ['spreadsheet'],
    )

    // And a workbook is a leaf: nothing may be filed under it, for the same
    // reason nothing may be filed under an uploaded file.
    const document = await provider.createPage({
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      spaceId: seed.spaceId,
      title: 'Notes',
      body: 'notes',
      authorId: seed.userId,
      authorType: 'user',
      createdBy: seed.userId,
    })
    const refused = await provider.movePage({
      organizationId: seed.organizationId,
      pageId: document.id,
      parentPageId: pageId,
      position: 0,
    })
    assert.equal(refused, null, 'a spreadsheet cannot be a parent')
  } finally {
    await service.shutdown?.()
    await seed.teardown()
  }
})
