import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createMockRunInference, loadScenario } from '@nessie/mock-llm'

import { runAgenticLoop, type BudgetLimits } from '../../src/run/agentic-loop.js'
import { executeBuiltinTool } from '../../src/run/tools.js'
import { answerOf, seedSpreadsheetRun } from './spreadsheet-fixture.js'
import { runDatabaseTest } from './support.js'

// A scripted run, end to end: the `spreadsheet-agent-edit` scenario drives the
// real agentic loop into the real builtins, against a real database and a real
// IronCalc model. What it proves is the shape of the whole feature rather than
// any one call — an agent can open a workbook it has never seen, read it, write
// into it with no approval gate anywhere, notice it was wrong, and put the
// document back using the version the write door saved for it.
//
// It also watches the presence lane, because an agent editing has to *look*
// like a person editing: without that, "no approval gate" would mean nobody
// finds out until the numbers are already different.

const HIGH = 1_000_000
const budget: BudgetLimits = {
  maxCostCents: HIGH,
  maxIterations: HIGH,
  maxTokens: HIGH,
  maxToolCalls: HIGH,
  maxWallclockMs: HIGH,
  toolTimeoutMs: HIGH,
}

const callbacks = () => ({
  onBudgetExhausted: async () => undefined,
  onIterationStart: async () => undefined,
  onTextDelta: async () => undefined,
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
})

type PresenceFrame = {
  clientId: string
  sheet: number
  selection: { r0: number; c0: number; r1: number; c1: number }
  draft: { r: number; c: number; text: string } | null
  actor: { type: string; displayName: string; color: string; agentId?: string }
}

runDatabaseTest('the scripted spreadsheet run edits, regrets it, and restores', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-run')
  t.after(fixture.cleanup)

  // Set up by an earlier run, so the scripted run below arrives at a workbook
  // that already has content — and its own first write is genuinely its first.
  const earlier = { ...fixture.context, run: { ...fixture.context.run, id: randomUUID() } }
  const created = answerOf<{ pageId: string }>(
    await executeBuiltinTool(
      'sheet_create',
      {
        spaceId: fixture.spaceId,
        title: 'Regional revenue',
        sheets: [{ name: 'Sheet1', rows: [['Region', 'Revenue'], ['North', 10]] }],
      },
      earlier,
    ),
  )
  assert.ok(created.pageId)

  // A scenario is written before any of these ids exist, so it names them by
  // placeholder and the harness fills them in. The scenario's job is to pin the
  // *sequence* of calls an agent makes, which is the part that has to stay true.
  let safetyNetVersionId: string | null = null
  const toolCalls: string[] = []
  const answers: Record<string, unknown>[] = []

  const result = await runAgenticLoop({
    budget,
    callbacks: callbacks(),
    executeTool: async (toolName, rawArgs, _context) => {
      toolCalls.push(toolName)
      const args = JSON.parse(
        JSON.stringify(rawArgs)
          .replaceAll('__PAGE__', created.pageId)
          .replaceAll('__VERSION__', safetyNetVersionId ?? created.pageId),
      ) as Record<string, unknown>
      const executed = await executeBuiltinTool(toolName, args, {
        ...fixture.context,
        toolCallId: `scripted-${toolCalls.length}`,
      })
      assert.equal(executed.success, true, `${toolName} failed: ${executed.output}`)
      const answer = answerOf(executed)
      answers.push(answer)
      const outcome = answer.outcome as { versionId?: string | null } | undefined
      // The version the write door took before this run's first write: the one
      // the agent restores two turns later.
      safetyNetVersionId ??= outcome?.versionId ?? null
      return { inputSummary: toolName, output: JSON.stringify(answer), success: true }
    },
    initialMessages: [{ content: 'Put the quarter into that sheet.', role: 'user' }],
    runInference: createMockRunInference(await loadScenario('spreadsheet-agent-edit')),
    tools: [],
  })

  assert.deepEqual(toolCalls, [
    'sheet_describe',
    'sheet_read_range',
    'sheet_write_range',
    'sheet_versions',
  ])
  assert.equal(result.exhaustedBudget, null)
  assert.match(result.finalText, /restored the version/)

  // No approval gate anywhere in that sequence — and the safety net is why that
  // is acceptable rather than reckless.
  assert.ok(safetyNetVersionId, 'the first write of the run should have taken a version')

  const back = answerOf<{ rows: string[][] }>(
    await executeBuiltinTool(
      'sheet_read_range',
      { pageId: created.pageId, range: 'A1:B2' },
      fixture.context,
    ),
  )
  assert.deepEqual(back.rows, [['Region', 'Revenue'], ['North', '10']])
})

runDatabaseTest('an agent announces where it is working before it writes there', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-presence')
  t.after(fixture.cleanup)

  const created = answerOf<{ pageId: string }>(
    await executeBuiltinTool(
      'sheet_create',
      { spaceId: fixture.spaceId, title: 'Watched' },
      fixture.context,
    ),
  )
  fixture.published.length = 0

  await executeBuiltinTool(
    'sheet_write_range',
    { pageId: created.pageId, sheet: 'Sheet1', range: 'B2', rows: [['hello', 'there']] },
    { ...fixture.context, toolCallId: 'presence-write' },
  )

  const presence = fixture.published
    .filter((frame) => frame.event === 'sheet.presence')
    .map((frame) => frame.data as PresenceFrame)
  assert.ok(presence.length >= 4, `expected an arrival, two drafts and a settle, got ${presence.length}`)

  // Its own identity and its own colour — the same palette entry its avatar
  // uses everywhere else, so a person recognises who is in their document.
  const first = presence[0]!
  assert.equal(first.actor.type, 'agent')
  assert.equal(first.actor.agentId, fixture.agentId)
  assert.match(first.actor.color, /^#[0-9A-Fa-f]{6}$/)
  assert.equal(first.clientId, `run:${fixture.runId}`)

  // The arrival names the range and carries no draft: "the agent is looking at
  // B2:C2" comes before anything changes.
  assert.deepEqual(first.selection, { r0: 2, c0: 2, r1: 2, c1: 2 })
  assert.equal(first.draft, null)

  const drafts = presence.filter((frame) => frame.draft !== null)
  assert.deepEqual(
    drafts.map((frame) => frame.draft?.text),
    ['hello', 'there'],
  )
  // Every draft is published before the batch lands, which is the whole point:
  // a person sees what is about to arrive, not a summary of what already did.
  const firstBatchAt = fixture.published.findIndex((frame) => frame.event === 'sheet.ops')
  const lastDraftAt = fixture.published.findLastIndex(
    (frame) => frame.event === 'sheet.presence' && (frame.data as PresenceFrame).draft !== null,
  )
  assert.ok(firstBatchAt > lastDraftAt, 'the drafts should precede the applied batch')

  assert.equal(presence[presence.length - 1]?.draft, null, 'the last frame clears the draft')
})

runDatabaseTest('a read announces its range too, and drafts nothing', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-presence-read')
  t.after(fixture.cleanup)

  const created = answerOf<{ pageId: string }>(
    await executeBuiltinTool(
      'sheet_create',
      {
        spaceId: fixture.spaceId,
        title: 'Read me',
        sheets: [{ rows: [['a', 'b'], ['c', 'd']] }],
      },
      fixture.context,
    ),
  )
  fixture.published.length = 0

  await executeBuiltinTool(
    'sheet_read_range',
    { pageId: created.pageId, range: 'A1:B2' },
    fixture.context,
  )

  const presence = fixture.published
    .filter((frame) => frame.event === 'sheet.presence')
    .map((frame) => frame.data as PresenceFrame)
  assert.ok(presence.length >= 1)
  assert.deepEqual(presence[0]?.selection, { r0: 1, c0: 1, r1: 2, c1: 2 })
  assert.ok(presence.every((frame) => frame.draft === null))
})

runDatabaseTest('filters, replace and tabs all land through the same write door', async (t) => {
  const fixture = await seedSpreadsheetRun('sheet-surface')
  t.after(fixture.cleanup)

  const created = answerOf<{ pageId: string }>(
    await executeBuiltinTool(
      'sheet_create',
      {
        spaceId: fixture.spaceId,
        title: 'Tickets',
        sheets: [{
          name: 'Board',
          rows: [
            ['Ticket', 'State'],
            ['KM-1', 'open'],
            ['KM-2', 'done'],
            ['KM-3', 'open'],
          ],
        }],
      },
      fixture.context,
    ),
  )
  const pageId = created.pageId
  const run = async (tool: string, args: Record<string, unknown>) => {
    const executed = await executeBuiltinTool(tool, { pageId, ...args }, {
      ...fixture.context,
      toolCallId: `surface-${tool}-${Math.random().toString(16).slice(2)}`,
    })
    assert.equal(executed.success, true, `${tool} failed: ${executed.output}`)
    return answerOf(executed)
  }

  const filtered = await run('sheet_filter', {
    sheet: 'Board',
    action: 'set',
    range: 'A1:B4',
    columns: { B: { values: ['open'] } },
  })
  assert.equal(filtered.hidden, 1, 'the done row should be hidden')

  // A filtered read shows what a person looking at the sheet sees.
  const visible = await run('sheet_read_range', { sheet: 'Board', range: 'A1:B4' })
  assert.deepEqual((visible.rows as string[][]).map((row) => row[0]), ['Ticket', 'KM-1', 'KM-3'])
  assert.equal(visible.hiddenRowsOmitted, 1)

  const everything = await run('sheet_read_range', {
    sheet: 'Board',
    range: 'A1:B4',
    includeHidden: true,
  })
  assert.equal((everything.rows as string[][]).length, 4)

  const got = await run('sheet_filter', { sheet: 'Board', action: 'get' })
  assert.equal(got.hiddenRows, 1)

  // Replace changes ONE cell by default and says what else matched, so an
  // agent cannot rewrite a workbook by accident.
  const replaced = await run('sheet_replace', {
    query: 'open',
    replacement: 'blocked',
  })
  assert.equal(replaced.applied, 1)
  assert.equal((replaced.stillMatching as unknown[]).length, 1)

  const tabs = await run('sheet_tabs', { action: 'duplicate', name: 'Board', newName: 'Board copy' })
  assert.deepEqual(tabs.sheets, ['Board', 'Board copy'])
  const copied = await run('sheet_read_range', { sheet: 'Board copy', range: 'A1:B4' })
  assert.deepEqual((copied.rows as string[][])[0], ['Ticket', 'State'])

  const cleared = await run('sheet_filter', { sheet: 'Board', action: 'clear' })
  assert.equal(cleared.cleared, true)
})
