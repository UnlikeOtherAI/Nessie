import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  LedgerResearchListSchema,
  LedgerResearchReportSchema,
  LedgerResearchStatusDtoSchema,
  LedgerResearchTicketSchema,
  LedgerScopeResultSchema,
  LedgerToolErrorSchema,
} from '../index.js'

/**
 * Ledger's own published DTO examples (`docs/contracts/scope-result.examples.json`
 * in Ledger, copied byte-for-byte to `fixtures/`), read through the schemas
 * the Nessie worker uses on every Ledger answer. A Ledger DTO these schemas
 * refuse would surface in production as a malformed response, so every
 * example must parse. Replace the fixture from Ledger, never by hand.
 */

const examples = JSON.parse(readFileSync(
  new URL('./fixtures/ledger-scope-result.examples.json', import.meta.url),
  'utf8',
)) as {
  scope_result: Record<string, unknown>
  status: Record<string, unknown>
  report: Record<string, unknown>
  ticket: unknown
  errors: Record<string, { mcp: unknown }>
}

test('every published ScopeResult parses', () => {
  for (const [name, example] of Object.entries(examples.scope_result)) {
    const parsed = LedgerScopeResultSchema.safeParse(example)
    assert.ok(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`)
  }
  const transcript = LedgerScopeResultSchema.parse(examples.scope_result.turn_complete_with_transcript)
  assert.equal(transcript.brief?.messages?.length, 2)
  assert.deepEqual(transcript.brief?.lockedSettings, ['recency'])
  assert.equal(transcript.brief?.analysis?.complexity, 'high')
  const failed = LedgerScopeResultSchema.parse(examples.scope_result.turn_failed_retryable)
  assert.deepEqual(
    { seq: failed.turn?.seq, status: failed.turn?.status, retryable: failed.turn?.retryable },
    { seq: 2, status: 'failed', retryable: true },
  )
  assert.equal(LedgerScopeResultSchema.parse(examples.scope_result.dispatching_before_water_answered).brief, null)
})

test('every published status, report and ticket parses', () => {
  for (const [name, example] of Object.entries(examples.status)) {
    const parsed = LedgerResearchStatusDtoSchema.safeParse(example)
    assert.ok(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`)
  }
  const idle = LedgerResearchStatusDtoSchema.parse(examples.status.drafting_idle)
  assert.deepEqual(idle.brief, { revision: 3, turnPending: false })
  const complete = LedgerResearchStatusDtoSchema.parse(examples.status.complete_public)
  assert.match(complete.publicUrl ?? '', /^https:\/\/research\.deepwater\.live\//)

  assert.equal(LedgerResearchReportSchema.parse(examples.report.full).reportKind, 'full')
  assert.equal(LedgerResearchReportSchema.parse(examples.report.summary).reportKind, 'summary')
  assert.equal(LedgerResearchTicketSchema.parse(examples.ticket).status, 'running')
})

test('every published MCP tool error parses, keeping a revision conflict\'s revision', () => {
  for (const [name, example] of Object.entries(examples.errors)) {
    const parsed = LedgerToolErrorSchema.safeParse(example.mcp)
    assert.ok(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`)
  }
  assert.equal(LedgerToolErrorSchema.parse(examples.errors.scope_revision_conflict?.mcp).currentRevision, 3)
})

test('research_list rows are status DTOs plus the list\'s own fields, tolerating a pre-brief Ledger', () => {
  const list = LedgerResearchListSchema.parse({
    jobs: [
      {
        id: 'rs_01jzexamplebrief0000000000',
        status: 'running',
        progress: { phase: 'gather', note: 'Research is gathering', sources_found: 42, at: '2026-09-23T09:10:00.000Z' },
        eta_minutes: 20,
        title: 'EV battery recycling in the EU',
        error_code: null,
        public_url: null,
        query: 'How are EV batteries recycled in Europe?',
        depth: 'deep',
        recency: 'year',
        started_at: '2026-09-23T09:00:00.000Z',
        completed_at: null,
        has_report: false,
        scoped: true,
      },
      {
        // A research started before briefs: no title, error code, link or scoped flag.
        id: 'rs_01jzexamplelegacy000000000',
        status: 'complete',
        query: 'Heat pumps in older houses',
        depth: 'standard',
        recency: 'any',
        started_at: '2026-09-01T09:00:00.000Z',
        completed_at: '2026-09-01T09:30:00.000Z',
        has_report: true,
      },
    ],
    limit: 20,
  })
  assert.equal(list.limit, 20)
  assert.deepEqual(
    list.jobs.map((job) => ({ id: job.id, scoped: job.scoped, hasReport: job.hasReport, sources: job.sourcesFound })),
    [
      { id: 'rs_01jzexamplebrief0000000000', scoped: true, hasReport: false, sources: 42 },
      { id: 'rs_01jzexamplelegacy000000000', scoped: false, hasReport: true, sources: null },
    ],
  )
  assert.equal(list.jobs[1]?.title, null)
  assert.equal(LedgerResearchListSchema.safeParse({ jobs: [{ id: 'job-1', status: 'running' }], limit: 20 }).success, false)
})
