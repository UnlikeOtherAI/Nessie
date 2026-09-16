import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createEmptyWorkbook, loadWorkbook } from '@nessie/knowledge'
import { buildDocumentEnvelope } from '@nessie/runtime'

import { createDocumentLane, type DocumentSseConnection } from '../src/realtime/document-lane.js'
import { canReadSpaceForDocumentLane } from '../src/realtime/knowledge-page-entitlement.js'

import {
  createSpreadsheetVia,
  dbAvailable,
  seedSpreadsheetRoutes,
  type SpreadsheetRouteFixture,
} from './spreadsheet-route-fixture.ts'

const dbTest = dbAvailable ? test : test.skip

/**
 * What a `KnowledgePageShare` does to a spreadsheet.
 *
 * The write door was written before person-to-person sharing existed, so this
 * file is the proof that the kind picked the refactor up rather than quietly
 * opting out of it. Everything below happens in the **owner's personal space**:
 * `outsider` reaches nothing in it by any space rule, so every `200` here is
 * the share and nothing else, and every `403` is the absence of one.
 *
 * The matrix, from data-and-api.md §2 ("What an edit grant is, and is not"):
 *
 * | act                                        | view | edit | owner only |
 * |--------------------------------------------|------|------|------------|
 * | bootstrap, catch-up, range, find, export    | yes  | yes  |            |
 * | presence                                    | yes  | yes  |            |
 * | ops, structure, replace, filters            | no   | yes  |            |
 * | save a version, restore a version           | no   | yes  |            |
 * | publish, move, delete                       | no   | no   | yes        |
 *
 * Two properties are load-bearing beyond the table. A refusal is decided from
 * the actor context and the page *before* `body.summary` is read — the reader
 * case in `spreadsheet-summary-advisory.test.ts` makes the same point about a
 * space grant, and a share must not become the exception. And revocation is a
 * hard delete, so the next request answers the new truth with nothing to
 * invalidate.
 */

type Access = 'view' | 'edit'

const shareWith = async (
  fixture: SpreadsheetRouteFixture,
  pageId: string,
  access: Access,
): Promise<string> => {
  const page = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
  const share = await fixture.prisma.knowledgePageShare.create({
    data: {
      organizationId: fixture.organizationId,
      pageId,
      spaceId: page.spaceId,
      granteeUserId: fixture.ids.outsider,
      grantedByUserId: fixture.ids.owner,
      access,
    },
  })
  return share.id
}

const diffsFor = (client: ReturnType<typeof createEmptyWorkbook>, edit: () => void): string => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue()).toString('base64')
}

/** The smallest filter model the schema accepts. */
const filterModel = () => ({
  range: { r0: 1, c0: 1, r1: 5, c1: 3 },
  columns: {},
  hiddenRows: [],
  appliedAtSeq: '0',
})

const presenceFrame = () => ({
  clientId: randomUUID(),
  sheet: 0,
  selection: { r0: 1, c0: 1, r1: 1, c1: 1 },
  cursor: { r: 1, c: 1 },
  draft: null,
  ts: new Date().toISOString(),
})

const bootstrap = async (fixture: SpreadsheetRouteFixture, actor: 'owner' | 'outsider', pageId: string) =>
  fixture.request(actor, {
    method: 'GET',
    url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
  })

/** Every write door on the spreadsheet surface, as the outsider would knock. */
const writeAttempts = async (
  fixture: SpreadsheetRouteFixture,
  pageId: string,
  baseSeq: number,
  snapshot: Buffer,
): Promise<{ name: string; statusCode: number }[]> => {
  const client = loadWorkbook(snapshot)
  const attempts: [string, Parameters<SpreadsheetRouteFixture['request']>[1]][] = [
    ['ops', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
      payload: {
        clientOpId: randomUUID(),
        baseSeq,
        diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'from a grantee')),
        // A summary that claims the most it is allowed to claim. A `view`
        // share must be refused without this ever being read.
        summary: {
          structuralKind: 'deleteSheet',
          sheetIndexes: [0, 1, 2],
          cellCount: 999_999,
          touched: [{ sheet: 0, r0: 1, c0: 1, r1: 1_000, c1: 1_000 }],
          intents: [{ kind: 'deleteRows', sheet: 0, row: 1, count: 10_000 }],
        },
      },
    }],
    ['structure', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/structure`,
      payload: { action: { kind: 'addSheet', name: 'Grantee' } },
    }],
    ['replace', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/replace`,
      payload: { query: 'seed', replacement: 'replaced' },
    }],
    ['set filter', {
      method: 'PUT',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/filters/0`,
      payload: filterModel(),
    }],
    ['clear filter', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/filters/0`,
    }],
    ['save a version', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/versions`,
      payload: { changeComment: 'grantee snapshot' },
    }],
  ]
  const results: { name: string; statusCode: number }[] = []
  for (const [name, request] of attempts) {
    const response = await fixture.request('outsider', request)
    results.push({ name, statusCode: response.statusCode })
  }
  return results
}

dbTest('a view share reads everything and writes nothing', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-share-view')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.personalSpaceId)

    // Without a share the page is not even visible: the 403s below are the
    // *write* half of the grant, not the absence of the grant itself.
    assert.equal((await bootstrap(fixture, 'outsider', pageId)).statusCode, 403)

    await shareWith(fixture, pageId, 'view')

    const opened = await bootstrap(fixture, 'outsider', pageId)
    assert.equal(opened.statusCode, 200)
    const data = (opened.json() as {
      data: { headSeq: number; snapshot: { bytes: string }; viewer: { canWrite: boolean } }
    }).data
    // The pane opens read-only rather than discovering it on the first edit.
    assert.equal(data.viewer.canWrite, false)

    for (const [name, url] of [
      ['catch-up', `/api/knowledge-base/pages/${pageId}/spreadsheet/ops?afterSeq=0`],
      ['range', `/api/knowledge-base/pages/${pageId}/spreadsheet/range?a1=A1:B2`],
      ['find', `/api/knowledge-base/pages/${pageId}/spreadsheet/find?q=seed`],
      ['export', `/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=xlsx`],
    ] as const) {
      const response = await fixture.request('outsider', { method: 'GET', url })
      assert.equal(response.statusCode, 200, `${name} should be open to a view share`)
    }

    // Presence is a read: a viewer appears in the pane's avatar strip.
    const presence = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/presence`,
      payload: { frame: presenceFrame() },
    })
    assert.equal(presence.statusCode, 200, presence.body)

    const refusals = await writeAttempts(
      fixture,
      pageId,
      data.headSeq,
      Buffer.from(data.snapshot.bytes, 'base64'),
    )
    assert.deepEqual(
      refusals.filter((attempt) => attempt.statusCode !== 403),
      [],
      `every write door must answer 403 to a view share: ${JSON.stringify(refusals)}`,
    )

    // And nothing the refused batch claimed reached the database — the summary
    // was never an input to any of it.
    assert.equal(await fixture.prisma.spreadsheetOpBatch.count({ where: { pageId } }), 0)
    const head = await fixture.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId } })
    assert.equal(Number(head.headSeq), 0)
    assert.deepEqual(head.sheetNames, ['Sheet1'])
  } finally {
    await fixture.teardown()
  }
})

dbTest('an edit share writes, and still may not publish, move or delete', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-share-edit')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.personalSpaceId)
    await shareWith(fixture, pageId, 'edit')

    const opened = await bootstrap(fixture, 'outsider', pageId)
    assert.equal(opened.statusCode, 200)
    const data = (opened.json() as {
      data: { headSeq: number; snapshot: { bytes: string }; viewer: { canWrite: boolean } }
    }).data
    assert.equal(data.viewer.canWrite, true, 'an edit grantee opens the pane writable')

    const client = loadWorkbook(Buffer.from(data.snapshot.bytes, 'base64'))
    const wrote = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
      payload: {
        clientOpId: randomUUID(),
        baseSeq: data.headSeq,
        diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'from a grantee')),
        summary: { structuralKind: null, sheetIndexes: [0], cellCount: 1, touched: [] },
      },
    })
    assert.equal(wrote.statusCode, 200, wrote.body)

    // The batch is audited under the grantee's own identity, in the owner's
    // organisation — the share moved one predicate, not the tenancy.
    const batch = await fixture.prisma.spreadsheetOpBatch.findFirstOrThrow({ where: { pageId } })
    assert.equal(batch.actorId, fixture.ids.outsider)
    assert.equal(batch.organizationId, fixture.organizationId)

    const filtered = await fixture.request('outsider', {
      method: 'PUT',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/filters/0`,
      payload: filterModel(),
    })
    assert.equal(filtered.statusCode, 200, filtered.body)

    const saved = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/versions`,
      payload: { changeComment: 'grantee snapshot' },
    })
    assert.equal(saved.statusCode, 201, saved.body)
    const versionId = (saved.json() as { data: { versionId: string } }).data.versionId

    const restored = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/versions/${versionId}/restore`,
      payload: {},
    })
    assert.equal(restored.statusCode, 200, restored.body)

    // The version the grantee wrote is theirs, as a person: no guest marker.
    const version = await fixture.prisma.knowledgePageVersion.findUniqueOrThrow({
      where: { id: versionId },
    })
    assert.equal(version.authorType, 'user')
    assert.equal(version.authorId, fixture.ids.outsider)

    // What an edit grant is not. These three go through `requirePageOwnerWrite`,
    // which ignores shares entirely.
    const ownerOnly: [string, Parameters<SpreadsheetRouteFixture['request']>[1]][] = [
      ['publish', { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/publish`, payload: {} }],
      ['move', {
        method: 'POST',
        url: `/api/knowledge-base/pages/${pageId}/move`,
        payload: { parentPageId: null, position: 1 },
      }],
      ['delete', { method: 'DELETE', url: `/api/knowledge-base/pages/${pageId}` }],
    ]
    for (const [name, request] of ownerOnly) {
      const response = await fixture.request('outsider', request)
      assert.equal(response.statusCode, 403, `${name} is the owner's act: ${response.body}`)
    }
    // The page is still live and still where the owner left it.
    const after = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
    assert.equal(after.deletedAt, null)
    assert.notEqual(after.status, 'archived')
  } finally {
    await fixture.teardown()
  }
})

dbTest('revoking a share closes the page again', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-share-revoke')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.personalSpaceId)
    const shareId = await shareWith(fixture, pageId, 'edit')
    assert.equal((await bootstrap(fixture, 'outsider', pageId)).statusCode, 200)

    // Revocation is a hard delete — the audit trail is the history.
    await fixture.prisma.knowledgePageShare.delete({ where: { id: shareId } })
    assert.equal((await bootstrap(fixture, 'outsider', pageId)).statusCode, 403)

    // Archiving is the other way a grant ends, without anybody revoking a row.
    await shareWith(fixture, pageId, 'view')
    assert.equal((await bootstrap(fixture, 'outsider', pageId)).statusCode, 200)
    await fixture.prisma.knowledgePage.update({
      where: { id: pageId },
      data: { status: 'archived' },
    })
    assert.equal((await bootstrap(fixture, 'outsider', pageId)).statusCode, 403)
  } finally {
    await fixture.teardown()
  }
})

dbTest('a shared folder carries the spreadsheets inside it', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-share-folder')
  try {
    const folder = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.personalSpaceId}/pages`,
      payload: { title: 'Q3 models', kind: 'folder' },
    })
    assert.equal(folder.statusCode, 201, folder.body)
    const folderId = (folder.json() as { data: { id: string } }).data.id

    const inside = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.personalSpaceId}/spreadsheets`,
      payload: { title: 'Runway', parentPageId: folderId },
    })
    assert.equal(inside.statusCode, 201, inside.body)
    const pageId = (inside.json() as { data: { id: string } }).data.id

    // One share, on the folder. The spreadsheet under it is reached by the
    // ancestor walk, never by a row of its own.
    await shareWith(fixture, folderId, 'edit')
    assert.equal(await fixture.prisma.knowledgePageShare.count({ where: { pageId } }), 0)

    const opened = await bootstrap(fixture, 'outsider', pageId)
    assert.equal(opened.statusCode, 200, opened.body)
    assert.equal(
      (opened.json() as { data: { viewer: { canWrite: boolean } } }).data.viewer.canWrite,
      true,
      'an edit share on the folder is an edit share on what is inside it',
    )

    // The folder's children listing: the space is private to the owner, so the
    // grantee reaches it only by naming the shared root.
    const listed = await fixture.request('outsider', {
      method: 'GET',
      url: `/api/knowledge-base/spaces/${fixture.personalSpaceId}/pages?sharedRootPageId=${folderId}`,
    })
    assert.equal(listed.statusCode, 200, listed.body)
    const rows = (listed.json() as { data: { id: string; kind: string }[] }).data
    assert.deepEqual(
      rows.filter((row) => row.id === pageId).map((row) => row.kind),
      ['spreadsheet'],
      'the spreadsheet is in the shared folder listing, as a spreadsheet',
    )

    // Creating inside the shared folder is writing inside the grant's subtree.
    const created = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.personalSpaceId}/spreadsheets`,
      payload: { title: 'Grantee model', parentPageId: folderId },
    })
    assert.equal(created.statusCode, 201, created.body)

    // Creating at the space root never consults shares at all.
    const atRoot = await fixture.request('outsider', {
      method: 'POST',
      url: `/api/knowledge-base/spaces/${fixture.personalSpaceId}/spreadsheets`,
      payload: { title: 'Not the grantee’s to file here' },
    })
    assert.equal(atRoot.statusCode, 403, atRoot.body)
  } finally {
    await fixture.teardown()
  }
})

/**
 * The live lane's *delivery-time* half of the same question.
 *
 * `accessPageSpace` decides whether the lane opens; `canReadSpaceForDocumentLane`
 * decides, every 5 s per connection, whether it keeps delivering. The two used
 * to disagree: the first knew about shares and the second did not, so a `view`
 * grantee connected, stayed open and received nothing at all. This runs the
 * real predicate against the real database behind the real lane.
 */
const laneRecorder = (input: {
  pageId: string
  spaceId: string
  organizationId: string
  userId: string
}): DocumentSseConnection & { written: string[] } => {
  const written: string[] = []
  return {
    kind: 'document',
    ...input,
    clientId: randomUUID(),
    saturated: false,
    written,
    response: {
      once: () => undefined,
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
    },
  } as DocumentSseConnection & { written: string[] }
}

dbTest('the live lane delivers to a share, and stops within the window when it is revoked', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-share-lane')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.personalSpaceId)

    let clock = 0
    const lane = createDocumentLane({
      canAccessKnowledgePage: (input) => canReadSpaceForDocumentLane(fixture.prisma, input),
      now: () => clock,
    })
    const connection = laneRecorder({
      pageId,
      spaceId: fixture.personalSpaceId,
      organizationId: fixture.organizationId,
      userId: fixture.ids.outsider,
    })
    lane.documentConnections.add(connection)
    const send = () => lane.deliverDocumentNotification(
      buildDocumentEnvelope({
        pageId,
        organizationId: fixture.organizationId,
        event: 'sheet.presence.request',
        data: { pageId },
      }) as Parameters<typeof lane.deliverDocumentNotification>[0],
    )

    // No share: the lane is the same fail-closed door the connect was.
    await send()
    assert.equal(connection.written.length, 0)

    const shareId = await shareWith(fixture, pageId, 'view')
    clock += 5_001
    await send()
    assert.equal(connection.written.length, 1, 'a view share is enough to receive the workbook’s changes')

    // Revocation is a hard delete, so there is nothing to invalidate — the next
    // walk past the memo simply finds no row.
    await fixture.prisma.knowledgePageShare.delete({ where: { id: shareId } })
    await send()
    assert.equal(connection.written.length, 2, 'the memo still holds the old answer')

    clock += 5_001
    await send()
    assert.equal(connection.written.length, 2, 'a revoked grantee is cut off within the window')
  } finally {
    await fixture.teardown()
  }
})
