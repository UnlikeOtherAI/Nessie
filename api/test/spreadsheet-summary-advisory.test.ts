import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createEmptyWorkbook, loadWorkbook } from '@nessie/knowledge'
import type { SpreadsheetBatchSummary } from '@nessie/schemas'

import {
  createSpreadsheetVia,
  dbAvailable,
  seedSpreadsheetRoutes,
  type SpreadsheetRouteFixture,
} from './spreadsheet-route-fixture.ts'

const dbTest = dbAvailable ? test : test.skip

/**
 * **The batch summary is caller-supplied and advisory only** (owner decision 2).
 *
 * The server cannot decode the diff bytes, so the browser derives the summary
 * from the method calls it intercepted and a tool derives it from the tool
 * call. That summary feeds exactly three things — the structural-conflict
 * check, the filter remap, and audit/presence text — and is **never an input
 * to an authorization, tenancy or permission decision**. Those are settled
 * before it is read, from the actor context and the page's space, which is why
 * `applySpreadsheetBatch` takes it as a separate argument the access layer
 * never sees.
 *
 * This file is the proof. Three claims, one test each:
 *
 * 1. A lying summary from a reader is refused by access, with the summary
 *    unread.
 * 2. A lying summary from a writer lands with no more reach than an honest one.
 * 3. A false `structuralKind: null` costs the next crossing client exactly one
 *    rebase, and nothing else.
 */

const bootstrapOf = async (fixture: SpreadsheetRouteFixture, actor: 'owner' | 'member', pageId: string) => {
  const response = await fixture.request(actor, {
    method: 'GET',
    url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
  })
  assert.equal(response.statusCode, 200)
  return (response.json() as { data: { headSeq: number; snapshot: { bytes: string } } }).data
}

const diffsFor = (client: ReturnType<typeof createEmptyWorkbook>, edit: () => void): string => {
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  edit()
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue()).toString('base64')
}

/**
 * The most hostile summary this contract allows: it claims a structural edit
 * on every sheet, an enormous cell count and rectangles that do not describe
 * the bytes at all.
 */
const lyingSummary = (): SpreadsheetBatchSummary => ({
  structuralKind: 'deleteSheet',
  sheetIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  cellCount: 999_999,
  touched: [{ sheet: 0, r0: 1, c0: 1, r1: 1_000, c1: 1_000 }],
  intents: [{ kind: 'deleteRows', sheet: 0, row: 1, count: 10_000 }],
})

dbTest('a lying summary from a reader is refused by access, before it is read', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-advisory-reader')
  try {
    // A page in the space the reader may read and may not write.
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.readOnlySpaceId)

    // The reader can read it: the refusal below is about writing, not about
    // the page being invisible.
    const readable = await fixture.request('reader', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
    })
    assert.equal(readable.statusCode, 200)

    const client = createEmptyWorkbook('Sheet1')
    const refused = await fixture.request('reader', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
      payload: {
        clientOpId: randomUUID(),
        baseSeq: 0,
        diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'not allowed')),
        summary: lyingSummary(),
      },
    })

    assert.equal(refused.statusCode, 403)
    assert.equal((refused.json() as { error: { code: string } }).error.code, 'POLICY_DENIED')
    // Nothing the summary claimed reached the database, and the summary
    // claiming a *structural* change did not turn the refusal into anything
    // else: access answered first.
    assert.equal(await fixture.prisma.spreadsheetOpBatch.count({ where: { pageId } }), 0)
    const head = await fixture.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId } })
    assert.equal(Number(head.headSeq), 0)
    assert.equal(fixture.published.length, 0)
  } finally {
    await fixture.teardown()
  }
})

dbTest('a lying summary from a writer reaches no further than an honest one', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-advisory-writer')
  try {
    const honestPage = await createSpreadsheetVia(fixture, 'owner')
    const lyingPage = await createSpreadsheetVia(fixture, 'owner')

    const submit = async (pageId: string, summary: SpreadsheetBatchSummary) => {
      const bootstrap = await bootstrapOf(fixture, 'owner', pageId)
      const client = loadWorkbook(Buffer.from(bootstrap.snapshot.bytes, 'base64'))
      const response = await fixture.request('owner', {
        method: 'POST',
        url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
        payload: {
          clientOpId: randomUUID(),
          baseSeq: bootstrap.headSeq,
          diffs: diffsFor(client, () => client.model.setUserInput(0, 1, 1, 'one cell')),
          summary,
        },
      })
      assert.equal(response.statusCode, 200)
      return response
    }

    await submit(honestPage, {
      structuralKind: null,
      sheetIndexes: [0],
      cellCount: 1,
      touched: [{ sheet: 0, r0: 1, c0: 1, r1: 1, c1: 1 }],
    })
    await submit(lyingPage, lyingSummary())

    const [honest, lying] = await Promise.all(
      [honestPage, lyingPage].map((pageId) =>
        fixture.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId } }),
      ),
    )

    // The one thing that actually changed is identical: the bytes decide the
    // workbook, and the bytes were the same.
    assert.equal(Number(honest.headSeq), Number(lying.headSeq))
    assert.deepEqual(honest.sheetNames, lying.sheetNames)

    // The lie is confined to its own page and its own organisation. It touched
    // no other page, and it did not widen who may see this one.
    assert.equal(
      await fixture.prisma.spreadsheetOpBatch.count({ where: { pageId: lyingPage } }),
      1,
    )
    const lyingBatch = await fixture.prisma.spreadsheetOpBatch.findFirstOrThrow({
      where: { pageId: lyingPage },
    })
    assert.equal(lyingBatch.organizationId, fixture.organizationId, 'tenancy comes from the actor, not the summary')
    assert.equal(lyingBatch.actorId, fixture.ids.owner, 'the sender is audited under their own identity')

    // A reader who may not write this space still cannot, whatever the
    // previous batch's summary claimed about it.
    const stillRefused = await fixture.request('outsider', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${lyingPage}/spreadsheet`,
    })
    assert.equal(stillRefused.statusCode, 403)
  } finally {
    await fixture.teardown()
  }
})

dbTest('a false structuralKind: null costs the next crossing client one rebase', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-advisory-understated')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner')
    const bootstrap = await bootstrapOf(fixture, 'owner', pageId)
    const snapshot = Buffer.from(bootstrap.snapshot.bytes, 'base64')
    const surgeon = loadWorkbook(snapshot)
    const victim = loadWorkbook(snapshot)

    // A real structural edit, reported as an ordinary cell change.
    const lied = await fixture.request('owner', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
      payload: {
        clientOpId: randomUUID(),
        baseSeq: 0,
        diffs: diffsFor(surgeon, () => surgeon.model.insertRows(0, 1, 3)),
        summary: { structuralKind: null, sheetIndexes: [0], cellCount: 1, touched: [] },
      },
    })
    assert.equal(lied.statusCode, 200)

    // The crossing client is therefore *not* refused — that is the whole cost.
    const crossing = await fixture.request('member', {
      method: 'POST',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`,
      payload: {
        clientOpId: randomUUID(),
        baseSeq: 0,
        diffs: diffsFor(victim, () => victim.model.setUserInput(0, 2, 1, 'lands at the old row')),
        summary: { structuralKind: null, sheetIndexes: [0], cellCount: 1, touched: [] },
      },
    })
    assert.equal(
      crossing.statusCode,
      200,
      'the understated summary costs a rebase the client never got to do',
    )

    // What it did *not* cost: the batch is still that organisation's, still
    // audited under the sender, and still bounded by the durable versions.
    const batches = await fixture.prisma.spreadsheetOpBatch.findMany({
      where: { pageId },
      orderBy: { seq: 'asc' },
    })
    assert.deepEqual(batches.map((batch) => Number(batch.seq)), [1, 2])
    assert.ok(batches.every((batch) => batch.organizationId === fixture.organizationId))
    assert.deepEqual(
      batches.map((batch) => batch.actorId),
      [fixture.ids.owner, fixture.ids.member],
      'each batch is audited under the identity that sent it',
    )

    // And the document is still the organisation's own, misordered at worst:
    // a rebase or a restore repairs it, which is exactly the documented bound.
    const head = await fixture.prisma.spreadsheetHead.findUniqueOrThrow({ where: { pageId } })
    assert.equal(Number(head.headSeq), 2)
  } finally {
    await fixture.teardown()
  }
})
