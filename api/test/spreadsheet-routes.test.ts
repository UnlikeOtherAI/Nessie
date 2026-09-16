import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createEmptyWorkbook } from '@nessie/knowledge'

import { buildStreamCorsHeaders } from '../src/lib/server-origin-policy.js'
import {
  createSpreadsheetVia,
  dbAvailable,
  seedSpreadsheetRoutes,
} from './spreadsheet-route-fixture.ts'

const dbTest = dbAvailable ? test : test.skip

const diffs = (): string => {
  const client = createEmptyWorkbook('Sheet1')
  client.native.flushSendQueue()
  client.model.pauseEvaluation()
  client.model.setUserInput(0, 1, 1, 'edited')
  client.model.resumeEvaluation()
  client.model.evaluate()
  return Buffer.from(client.native.flushSendQueue()).toString('base64')
}

const batchPayload = () => ({
  clientOpId: randomUUID(),
  baseSeq: 0,
  diffs: diffs(),
  summary: { structuralKind: null, sheetIndexes: [0], cellCount: 1, touched: [] },
})

dbTest('the permission matrix matches the kind`s siblings, read for read and write for write', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-permissions')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.readOnlySpaceId)

    const cases: {
      name: string
      actor: 'owner' | 'member' | 'reader' | 'outsider'
      request: Parameters<typeof fixture.request>[1]
      expect: number
    }[] = [
      // Read: the space's read grant, which also enforces every-version-readable.
      { name: 'owner bootstraps', actor: 'owner', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet` } },
      { name: 'reader bootstraps', actor: 'reader', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet` } },
      { name: 'outsider cannot bootstrap', actor: 'outsider', expect: 403, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet` } },
      { name: 'reader catches up', actor: 'reader', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops?afterSeq=0` } },
      { name: 'reader reads a range', actor: 'reader', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/range?a1=A1` } },
      { name: 'reader finds', actor: 'reader', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/find?q=anything` } },
      { name: 'reader exports', actor: 'reader', expect: 200, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=csv` } },
      { name: 'outsider cannot export', actor: 'outsider', expect: 403, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/export?format=csv` } },

      // Write: the space's write grant.
      { name: 'member writes a batch', actor: 'member', expect: 200, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`, payload: batchPayload() } },
      { name: 'reader cannot write a batch', actor: 'reader', expect: 403, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/ops`, payload: batchPayload() } },
      { name: 'reader cannot restructure', actor: 'reader', expect: 403, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/structure`, payload: { action: { op: 'axis', action: { kind: 'insertRows', sheet: 0, row: 1, count: 1 } } } } },
      { name: 'reader cannot replace', actor: 'reader', expect: 403, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/replace`, payload: { query: 'x', replacement: 'y' } } },
      { name: 'reader cannot set a filter', actor: 'reader', expect: 403, request: { method: 'PUT', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/filters/0`, payload: { range: { r0: 1, c0: 1, r1: 2, c1: 2 }, columns: {}, hiddenRows: [], appliedAtSeq: '0' } } },
      { name: 'reader cannot save a version', actor: 'reader', expect: 403, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/spreadsheet/versions`, payload: { changeComment: 'nope' } } },

      // Presence: read access says where you are; a draft needs write.
      { name: 'reader announces a selection', actor: 'reader', expect: 200, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/presence`, payload: { frame: { clientId: 'c1', sheet: 0, selection: { r0: 1, c0: 1, r1: 1, c1: 1 }, cursor: { r: 1, c: 1 }, draft: null, ts: new Date().toISOString() } } } },
      { name: 'reader cannot show a draft', actor: 'reader', expect: 400, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/presence`, payload: { frame: { clientId: 'c1', sheet: 0, selection: { r0: 1, c0: 1, r1: 1, c1: 1 }, cursor: { r: 1, c: 1 }, draft: { r: 1, c: 1, text: 'typing' }, ts: new Date().toISOString() } } } },
      { name: 'member may show a draft', actor: 'member', expect: 200, request: { method: 'POST', url: `/api/knowledge-base/pages/${pageId}/presence`, payload: { frame: { clientId: 'c2', sheet: 0, selection: { r0: 1, c0: 1, r1: 1, c1: 1 }, cursor: { r: 1, c: 1 }, draft: { r: 1, c: 1, text: 'typing' }, ts: new Date().toISOString() } } } },

      // The live lane takes the same read grant as a bootstrap. Only the
      // refusals are injectable: a granted stream is hijacked and never ends,
      // so the happy path is driven over a real socket below.
      { name: 'outsider cannot open the live lane', actor: 'outsider', expect: 403, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/live?clientId=c1` } },
      { name: 'the live lane needs a clientId', actor: 'reader', expect: 400, request: { method: 'GET', url: `/api/knowledge-base/pages/${pageId}/live` } },
    ]

    for (const scenario of cases) {
      const response = await fixture.request(scenario.actor, scenario.request)
      assert.equal(
        response.statusCode,
        scenario.expect,
        `${scenario.name}: got ${response.statusCode} ${response.body.slice(0, 200)}`,
      )
    }
  } finally {
    await fixture.teardown()
  }
})

dbTest('a page that is not a spreadsheet is a 404, not a 400', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-not-a-spreadsheet')
  try {
    const page = await fixture.prisma.knowledgePage.create({
      data: {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        spaceId: fixture.spaceId,
        title: 'An ordinary document',
        kind: 'document',
        createdBy: fixture.ids.owner,
      },
    })
    const pageId = page.id

    // A 404 rather than a 400: the routes must reveal nothing about a page
    // the caller may not see, and "wrong kind" and "no such page" have to read
    // the same from outside.
    const response = await fixture.request('owner', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'KNOWLEDGE_PAGE_NOT_FOUND',
    )
  } finally {
    await fixture.teardown()
  }
})

dbTest('a bootstrap tells a reader they cannot write, rather than making them find out', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-can-write')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner', fixture.readOnlySpaceId)
    const reader = await fixture.request('reader', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
    })
    const member = await fixture.request('member', {
      method: 'GET',
      url: `/api/knowledge-base/pages/${pageId}/spreadsheet`,
    })
    assert.equal((reader.json() as { data: { viewer: { canWrite: boolean } } }).data.viewer.canWrite, false)
    assert.equal((member.json() as { data: { viewer: { canWrite: boolean } } }).data.viewer.canWrite, true)
  } finally {
    await fixture.teardown()
  }
})

/**
 * The tenant-host CORS rule.
 *
 * A stream that omits `teamHostBaseDomain` refuses every client on a team
 * subdomain, and the refusal is silent — the pane simply never receives an
 * event. That is PR #501's bug on three other streams, and this asserts the
 * live lane does not repeat it.
 */
test('the live lane allows a tenant-host origin, and still refuses a stranger', () => {
  const policy = {
    allowedOrigins: new Set(['https://app.nessie.works']),
    mode: 'production' as const,
    teamHostBaseDomain: 'nessie.works',
  }

  const tenant = buildStreamCorsHeaders({ ...policy, origin: 'https://acme.nessie.works' })
  assert.equal(tenant['Access-Control-Allow-Origin'], 'https://acme.nessie.works')
  assert.equal(tenant['Access-Control-Allow-Credentials'], 'true')
  assert.equal(tenant['Vary'], 'Origin')

  const listed = buildStreamCorsHeaders({ ...policy, origin: 'https://app.nessie.works' })
  assert.equal(listed['Access-Control-Allow-Origin'], 'https://app.nessie.works')

  // Without the base domain the tenant host is refused: this is the exact
  // omission the live route must never make.
  assert.deepEqual(
    buildStreamCorsHeaders({
      ...policy,
      teamHostBaseDomain: undefined,
      origin: 'https://acme.nessie.works',
    }),
    {},
  )

  assert.deepEqual(buildStreamCorsHeaders({ ...policy, origin: 'https://evil.example' }), {})
})

dbTest('the live route hands back the tenant-host CORS headers it was built with', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-live-cors')
  // A real socket, not `inject`: the route hijacks the reply and the response
  // never ends, so an injected request would simply never resolve. This is the
  // one test that has to open the stream for real.
  const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 })
  const abort = new AbortController()
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner')
    const response = await fetch(
      `${address}/api/knowledge-base/pages/${pageId}/live?clientId=${randomUUID()}`,
      {
        headers: {
          origin: 'https://acme.nessie.works',
          'x-spreadsheet-actor': 'owner',
        },
        signal: abort.signal,
      },
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://acme.nessie.works',
      'a pane on a team subdomain must not be silently cut off by CORS',
    )
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(response.headers.get('x-accel-buffering'), 'no')

    const reader = response.body?.getReader()
    const first = await reader?.read()
    assert.ok(
      new TextDecoder().decode(first?.value).startsWith(': stream connected'),
      'the stream announces itself so a proxy cannot sit on the first byte',
    )
    await reader?.cancel()

    // Joining asks the peers already on the page to re-announce, so a late
    // pane sees everybody without waiting out their 10 s heartbeat.
    assert.ok(fixture.published.some((event) => event.event === 'sheet.presence.request'))
  } finally {
    abort.abort()
    await fixture.teardown()
  }
})

dbTest('presence leave is published, and needs the clientId that is leaving', async () => {
  const fixture = await seedSpreadsheetRoutes('sheet-presence-leave')
  try {
    const pageId = await createSpreadsheetVia(fixture, 'owner')
    const missing = await fixture.request('owner', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${pageId}/presence`,
    })
    assert.equal(missing.statusCode, 400)

    fixture.published.length = 0
    const left = await fixture.request('owner', {
      method: 'DELETE',
      url: `/api/knowledge-base/pages/${pageId}/presence?clientId=pane-7`,
    })
    assert.equal(left.statusCode, 200)
    assert.deepEqual(
      fixture.published.map((event) => event.event),
      ['sheet.presence.leave'],
    )
    assert.deepEqual(fixture.published[0]?.data, { pageId, clientId: 'pane-7' })
  } finally {
    await fixture.teardown()
  }
})
