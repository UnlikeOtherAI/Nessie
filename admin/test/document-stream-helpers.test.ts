import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyDocumentDelta,
  applyDocumentEdit,
  createDocumentStreamEntry,
  mergeBootstrap,
  reconcileDocumentSessions,
  type DocumentStreamEntry,
} from '../src/facades/threads/document-stream-helpers.js'

const entry = (overrides: Partial<DocumentStreamEntry> = {}): DocumentStreamEntry => ({
  ...createDocumentStreamEntry({
    runId: 'run-1',
    sessionId: 'session-1',
    startedAt: '2026-08-13T10:00:00.000Z',
  }),
  ...overrides,
})

const summary = (overrides: Record<string, unknown> = {}) =>
  ({
    agentId: 'agent-1',
    chars: 0,
    errorReason: null,
    pageId: null,
    published: false,
    runId: 'run-1',
    sessionId: 'session-1',
    startedAt: '2026-08-13T10:00:00.000Z',
    status: 'streaming',
    target: { parentPageId: null, parentTitle: null, spaceId: null, spaceName: null },
    title: null,
    versionNumber: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

// --- composing: the degenerate case where every insertion lands at the end ---

test('composing appends: the next seq at the end grows the document', () => {
  const applied = applyDocumentDelta(entry({ appliedSeq: 3, markdown: 'Hel' }), {
    content: 'lo world',
    offset: 3,
    seq: 4,
  })

  assert.equal(applied.outcome, 'applied')
  assert.equal(applied.entry.markdown, 'Hello world')
  assert.equal(applied.entry.cursor, 11)
  assert.equal(applied.entry.appliedSeq, 4)
})

test('a whole compose replays from nothing, offsets increasing', () => {
  const composed = [
    { content: '# Notes', offset: 0, seq: 1 },
    { content: '\n\nFirst', offset: 7, seq: 2 },
    { content: ' line.', offset: 14, seq: 3 },
  ].reduce(
    (current, delta) => applyDocumentDelta(current, delta).entry,
    entry(),
  )

  assert.equal(composed.markdown, '# Notes\n\nFirst line.')
  assert.equal(composed.cursor, 20)
  assert.equal(composed.appliedSeq, 3)
})

// --- editing: insertion anywhere, ordered by seq ---

test('an edit splices its span out and parks the cursor there', () => {
  const applied = applyDocumentEdit(entry({ markdown: 'Hello cruel world' }), {
    editIndex: 1,
    offset: 6,
    removeLength: 6,
  })

  assert.equal(applied.outcome, 'applied')
  assert.equal(applied.entry.markdown, 'Hello world')
  assert.equal(applied.entry.cursor, 6)
  assert.equal(applied.entry.editIndex, 1)
})

test('an edit past the end of what we hold is a hole, never a splice', () => {
  const applied = applyDocumentEdit(entry({ markdown: 'Hello' }), {
    editIndex: 2,
    offset: 40,
    removeLength: 3,
  })

  assert.equal(applied.outcome, 'gap')
  assert.equal(applied.entry.markdown, 'Hello')
  assert.equal(applied.entry.needsBootstrap, true)
})

test('a delta inserts at the start of the document', () => {
  const applied = applyDocumentDelta(entry({ appliedSeq: 1, markdown: 'world' }), {
    content: 'Hello ',
    offset: 0,
    seq: 2,
  })

  assert.equal(applied.entry.markdown, 'Hello world')
  assert.equal(applied.entry.cursor, 6)
})

test('a delta inserts in the middle without disturbing either side', () => {
  const applied = applyDocumentDelta(entry({ appliedSeq: 1, markdown: 'Hello world' }), {
    content: 'brave ',
    offset: 6,
    seq: 2,
  })

  assert.equal(applied.entry.markdown, 'Hello brave world')
  assert.equal(applied.entry.cursor, 12)
})

test('a replacement that grows the document leaves it longer than it was', () => {
  const spliced = applyDocumentEdit(entry({ markdown: 'Ship it Tuesday.' }), {
    editIndex: 1,
    offset: 8,
    removeLength: 7,
  })
  const rewritten = applyDocumentDelta(spliced.entry, {
    content: 'the Tuesday after next',
    offset: 8,
    seq: 1,
  })

  assert.equal(rewritten.entry.markdown, 'Ship it the Tuesday after next.')
  assert.equal(rewritten.entry.cursor, 30)
})

test('a replacement that shrinks the document leaves it shorter', () => {
  const spliced = applyDocumentEdit(entry({ markdown: 'Ship it on a Tuesday.' }), {
    editIndex: 1,
    offset: 8,
    removeLength: 12,
  })
  const rewritten = applyDocumentDelta(spliced.entry, {
    content: 'today',
    offset: 8,
    seq: 1,
  })

  assert.equal(spliced.entry.markdown, 'Ship it .')
  assert.equal(rewritten.entry.markdown, 'Ship it today.')
  assert.equal(rewritten.entry.cursor, 13)
})

test('non-English text edits by code unit like any other', () => {
  const spliced = applyDocumentEdit(entry({ markdown: 'Zápis z porady 🎉' }), {
    editIndex: 1,
    offset: 8,
    removeLength: 7,
  })

  assert.equal(spliced.entry.markdown, 'Zápis z 🎉')
  assert.equal(spliced.entry.cursor, 8)
})

// --- ordering is seq, never offset ---

test('a seq already applied is dropped whole, wherever it claims to sit', () => {
  const current = entry({ appliedSeq: 4, markdown: 'Hello' })
  const applied = applyDocumentDelta(current, { content: 'Hello', offset: 0, seq: 4 })

  assert.equal(applied.outcome, 'duplicate')
  assert.equal(applied.entry, current)
})

test('a seq beyond the next one is a hole, even at a placeable offset', () => {
  const applied = applyDocumentDelta(entry({ appliedSeq: 2, markdown: 'Hello' }), {
    content: ' world',
    offset: 5,
    seq: 5,
  })

  assert.equal(applied.outcome, 'gap')
  assert.equal(applied.entry.markdown, 'Hello')
  assert.equal(applied.entry.needsBootstrap, true)
})

test('an offset past the end of the text is a hole even at the next seq', () => {
  const applied = applyDocumentDelta(entry({ appliedSeq: 1, markdown: 'Hello' }), {
    content: 'world',
    offset: 9,
    seq: 2,
  })

  assert.equal(applied.outcome, 'gap')
  assert.equal(applied.entry.needsBootstrap, true)
})

test('out-of-order arrival: the later seq holes, the earlier one still applies', () => {
  const current = entry({ appliedSeq: 1, markdown: 'Hello' })
  const ahead = applyDocumentDelta(current, { content: '!', offset: 5, seq: 3 })
  assert.equal(ahead.outcome, 'gap')

  const inOrder = applyDocumentDelta(current, { content: ' world', offset: 5, seq: 2 })
  assert.equal(inOrder.outcome, 'applied')
  assert.equal(inOrder.entry.markdown, 'Hello world')
})

// --- bootstrap repair ---

test('a bootstrap ahead by seq replaces the text and folds buffered frames', () => {
  const merged = mergeBootstrap(
    entry({ appliedSeq: 2, markdown: 'He' }),
    { lastSeq: 3, markdown: 'Hello ', offset: 6 },
    [
      { delta: { content: 'world', offset: 6, seq: 4 }, kind: 'delta' },
      { edit: { editIndex: 1, offset: 0, removeLength: 6 }, kind: 'edit' },
      { delta: { content: 'Hi ', offset: 0, seq: 5 }, kind: 'delta' },
    ],
  )

  assert.equal(merged.needsRefetch, false)
  assert.equal(merged.entry.markdown, 'Hi world')
  assert.equal(merged.entry.appliedSeq, 5)
  assert.equal(merged.entry.cursor, 3)
})

test('a bootstrap behind the client by seq keeps the local text', () => {
  const merged = mergeBootstrap(
    entry({ appliedSeq: 6, markdown: 'Hello worl' }),
    { lastSeq: 2, markdown: 'Hello', offset: 5 },
    [{ delta: { content: 'd!', offset: 10, seq: 7 }, kind: 'delta' }],
  )

  assert.equal(merged.needsRefetch, false)
  assert.equal(merged.entry.markdown, 'Hello world!')
})

test('a bootstrap still behind the buffered frames asks for a re-fetch', () => {
  const merged = mergeBootstrap(entry(), { lastSeq: 1, markdown: 'Hel', offset: 3 }, [
    { delta: { content: 'world', offset: 3, seq: 5 }, kind: 'delta' },
  ])

  assert.equal(merged.needsRefetch, true)
  assert.equal(merged.entry.markdown, 'Hel')
  assert.equal(merged.entry.needsBootstrap, true)
})

test('reconcile keeps live sessions, seeds new ones and nominates zombies for a GET', () => {
  const reconciliation = reconcileDocumentSessions(
    [
      entry({ markdown: 'text', sessionId: 'live' }),
      entry({ markdown: 'gone', sessionId: 'zombie' }),
      entry({ sessionId: 'protected' }),
      entry({ sessionId: 'finished', status: 'saved' }),
    ],
    [
      summary({ sessionId: 'live', title: 'Notes' }),
      summary({ sessionId: 'joined-late' }),
    ],
    new Set(['protected']),
  )

  assert.deepEqual(
    reconciliation.sessions.map((session) => session.sessionId),
    ['live', 'zombie', 'protected', 'finished', 'joined-late'],
  )
  assert.equal(reconciliation.sessions[0]?.title, 'Notes')
  assert.equal(reconciliation.sessions[0]?.markdown, 'text')
  assert.deepEqual(reconciliation.detailSessionIds, ['zombie', 'joined-late'])
})

test('a fresh entry adopts a base document that arrives at seq 0', () => {
  // An edit session's base is published before any delta, so it shares seq 0
  // with the entry the start event created. Discarding it would leave the
  // viewer on an empty page while every following offset pointed into text
  // they could not see.
  const entry = createDocumentStreamEntry({ runId: 'run-1', sessionId: 'session-1' })
  const base = '# Handbook\n\nSome existing prose.\n'
  const merged = mergeBootstrap(entry, { lastSeq: 0, markdown: base, offset: base.length })
  assert.equal(merged.entry.markdown, base)
  assert.equal(merged.needsRefetch, false)
})

test('a stale bootstrap never clobbers text already applied', () => {
  const entry = {
    ...createDocumentStreamEntry({ runId: 'run-1', sessionId: 'session-1' }),
    appliedSeq: 4,
    markdown: 'already streamed content',
  }
  const merged = mergeBootstrap(entry, { lastSeq: 0, markdown: 'stale', offset: 5 })
  assert.equal(merged.entry.markdown, 'already streamed content')
})
