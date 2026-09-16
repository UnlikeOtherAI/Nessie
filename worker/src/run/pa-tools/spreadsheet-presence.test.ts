import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  DRAFT_BUDGET_MS,
  DRAFT_CELL_LIMIT,
  planAgentPresence,
} from './spreadsheet-presence.js'

// The choreography is a pure plan precisely so its bounds can be asserted
// without a transport: the properties that matter — a selection first, drafts
// in reading order, a hard budget, and a cleared draft at the end — are all
// properties of the plan.

const at = new Date('2026-09-16T10:00:00.000Z')
const selection = { r0: 2, c0: 2, r1: 3, c1: 3 }

test('a read announces a selection and a cursor, and drafts nothing', () => {
  const plan = planAgentPresence({ clientId: 'run:page', sheet: 0, selection, now: at })
  assert.deepEqual(plan.arrival.selection, selection)
  assert.deepEqual(plan.arrival.cursor, { r: 2, c: 2 })
  assert.equal(plan.arrival.draft, null)
  assert.equal(plan.drafts.length, 0)
  // A person watching sees "the agent is looking at B2:C3" — which is the
  // whole reason reads publish presence at all.
  assert.equal(plan.settled.draft, null)
})

test('a small write drafts every cell, in reading order, anchored at the top-left', () => {
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 1,
    selection,
    rows: [['a', 'b'], ['c', 'd']],
    now: at,
  })
  assert.deepEqual(
    plan.drafts.map((step) => step.frame.draft),
    [
      { r: 2, c: 2, text: 'a' },
      { r: 2, c: 3, text: 'b' },
      { r: 3, c: 2, text: 'c' },
      { r: 3, c: 3, text: 'd' },
    ],
  )
  for (const step of plan.drafts) assert.equal(step.frame.sheet, 1)
})

test('the whole choreography fits the budget, however many cells it covers', () => {
  const rows = [Array.from({ length: DRAFT_CELL_LIMIT }, (_, index) => `v${index}`)]
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 0,
    selection: { r0: 1, c0: 1, r1: 1, c1: DRAFT_CELL_LIMIT },
    rows,
    now: at,
  })
  const total = plan.drafts.reduce((sum, step) => sum + step.delayMs, 0)
  assert.ok(total <= DRAFT_BUDGET_MS, `${total}ms exceeds the ${DRAFT_BUDGET_MS}ms budget`)
  assert.equal(plan.drafts.length, DRAFT_CELL_LIMIT)
})

test('a large write announces its range and then simply lands', () => {
  // A five-thousand-cell write must not stall the run pretending to type, and
  // must not fake a cell-by-cell approach to work that did not happen that way.
  const rows = Array.from({ length: 10 }, () =>
    Array.from({ length: DRAFT_CELL_LIMIT }, () => 'x'))
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 0,
    selection: { r0: 1, c0: 1, r1: 10, c1: DRAFT_CELL_LIMIT },
    rows,
    now: at,
  })
  assert.equal(plan.drafts.length, 0)
  assert.deepEqual(plan.arrival.cursor, { r: 1, c: 1 })
})

test('a draft is clipped to the presence frame cap rather than refused', () => {
  const long = 'x'.repeat(4_000)
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 0,
    selection: { r0: 1, c0: 1, r1: 1, c1: 1 },
    rows: [[long]],
    now: at,
  })
  // `SpreadsheetPresenceFrameSchema` caps a draft at 256 characters and would
  // otherwise reject the frame — which would silently drop the one thing the
  // person is watching for.
  assert.equal(plan.drafts[0]?.frame.draft?.text.length, 256)
})

test('a null cell drafts as an empty cell, not as the string "null"', () => {
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 0,
    selection: { r0: 5, c0: 5, r1: 5, c1: 5 },
    rows: [[null]],
    now: at,
  })
  assert.equal(plan.drafts[0]?.frame.draft?.text, '')
})

test('the settled frame keeps the selection and clears the draft', () => {
  const plan = planAgentPresence({
    clientId: 'run:page',
    sheet: 0,
    selection,
    rows: [['a']],
    now: at,
  })
  assert.deepEqual(plan.settled.selection, selection)
  assert.equal(plan.settled.draft, null)
  assert.equal(plan.settled.clientId, 'run:page')
})

test('the draft choreography survives an otherwise idle process', () => {
  // The sleeps between drafts must hold the event loop open. Unref'd, a process
  // with nothing else pending drains while the choreography is mid-flight: the
  // `await` never returns, the tool call stops halfway, and under `node --test`
  // the whole file dies as `cancelledByParent` with no location to chase. It
  // passed locally for weeks because concurrent work kept the loop alive, and
  // failed in CI every time.
  //
  // Proven in a child process with nothing else scheduled: it prints the frame
  // count only if the run actually reached the end.
  const script = `
    void (async () => {
      const m = await import(${JSON.stringify(
        new URL('./spreadsheet-presence.ts', import.meta.url).href,
      )})
      const published = []
      const publisher = m.createAgentPresencePublisher(
        { publish: async (event) => { published.push(event) } },
        {
          actor: {
            type: 'agent',
            id: 'agent-1',
            displayName: 'Sheets',
            color: '#2563eb',
            agentId: '00000000-0000-4000-8000-000000000009',
          },
          canWrite: true,
          clientId: 'run:00000000-0000-4000-8000-000000000003',
          organizationId: '00000000-0000-4000-8000-000000000001',
          pageId: '00000000-0000-4000-8000-000000000002',
        },
      )
      await publisher.announce({
        sheet: 0,
        sheetName: 'Sheet1',
        selection: { r0: 2, c0: 2, r1: 2, c1: 3 },
        rows: [['hello', 'there']],
      })
      process.stdout.write('FRAMES:' + published.length)
    })()
  `
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  // The marker is what matters: it prints only if every `await sleep(...)`
  // returned. What the frames carry is asserted by the tests above, against the
  // plan rather than a transport.
  assert.match(
    run.stdout,
    /FRAMES:\d/u,
    `the choreography stopped in an idle process — stdout ${JSON.stringify(run.stdout)}, stderr ${run.stderr}`,
  )
})
