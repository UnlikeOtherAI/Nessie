import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyDocumentDelta,
  createDocumentStreamEntry,
  mergeBootstrap,
  reconcileDocumentSessions,
  repairStreamingTail,
  splitMarkdownBlocks,
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

test('a delta contiguous with the entry appends its whole content', () => {
  const applied = applyDocumentDelta(entry({ markdown: 'Hel', offset: 3 }), {
    content: 'lo world',
    offset: 3,
    seq: 4,
  })

  assert.equal(applied.outcome, 'applied')
  assert.equal(applied.entry.markdown, 'Hello world')
  assert.equal(applied.entry.offset, 11)
  assert.equal(applied.entry.lastSeq, 4)
})

test('an exact-duplicate delta changes nothing at all', () => {
  const current = entry({ lastSeq: 2, markdown: 'Hello', offset: 5 })
  const applied = applyDocumentDelta(current, { content: 'Hello', offset: 0, seq: 1 })

  assert.equal(applied.outcome, 'duplicate')
  assert.equal(applied.entry, current)
})

test('an overlapping delta contributes only its straddling tail', () => {
  const applied = applyDocumentDelta(entry({ markdown: 'Hello', offset: 5 }), {
    content: 'llo there',
    offset: 2,
    seq: 7,
  })

  assert.equal(applied.outcome, 'applied')
  assert.equal(applied.entry.markdown, 'Hello there')
  assert.equal(applied.entry.offset, 11)
})

test('a delta past the end is a hole: never applied, flagged for bootstrap', () => {
  const applied = applyDocumentDelta(entry({ markdown: 'Hello', offset: 5 }), {
    content: 'world',
    offset: 9,
    seq: 9,
  })

  assert.equal(applied.outcome, 'gap')
  assert.equal(applied.entry.markdown, 'Hello')
  assert.equal(applied.entry.needsBootstrap, true)
})

test('a bootstrap ahead of the client replaces the text and folds buffered deltas', () => {
  const merged = mergeBootstrap(
    entry({ markdown: 'He', offset: 2 }),
    { lastSeq: 3, markdown: 'Hello ', offset: 6 },
    [
      { content: 'world', offset: 6, seq: 4 },
      { content: 'llo ', offset: 2, seq: 3 },
    ],
  )

  assert.equal(merged.needsRefetch, false)
  assert.equal(merged.entry.markdown, 'Hello world')
  assert.equal(merged.entry.offset, 11)
  assert.equal(merged.entry.lastSeq, 4)
})

test('a bootstrap behind the client keeps the local text', () => {
  const merged = mergeBootstrap(
    entry({ lastSeq: 6, markdown: 'Hello worl', offset: 10 }),
    { lastSeq: 2, markdown: 'Hello', offset: 5 },
    [{ content: ' world!', offset: 5, seq: 7 }],
  )

  assert.equal(merged.needsRefetch, false)
  assert.equal(merged.entry.markdown, 'Hello world!')
})

test('a bootstrap still behind the buffered deltas asks for a re-fetch', () => {
  const merged = mergeBootstrap(entry(), { lastSeq: 1, markdown: 'Hel', offset: 3 }, [
    { content: 'world', offset: 6, seq: 5 },
  ])

  assert.equal(merged.needsRefetch, true)
  assert.equal(merged.entry.markdown, 'Hel')
  assert.equal(merged.entry.needsBootstrap, true)
})

test('reconcile keeps live sessions, seeds new ones and nominates zombies for a GET', () => {
  const reconciliation = reconcileDocumentSessions(
    [
      entry({ markdown: 'text', offset: 4, sessionId: 'live' }),
      entry({ markdown: 'gone', offset: 4, sessionId: 'zombie' }),
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

test('blocks split on top-level blank lines only', () => {
  assert.deepEqual(splitMarkdownBlocks('# Title\n\nFirst para\n\n\nSecond para'), [
    '# Title',
    'First para',
    'Second para',
  ])
})

test('a blank line inside a backtick fence never splits a block', () => {
  const markdown = '```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '```js\nconst a = 1\n\nconst b = 2\n```',
    'After',
  ])
})

test('tilde fences behave like backtick fences', () => {
  const markdown = '~~~\nline\n\nline\n~~~\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['~~~\nline\n\nline\n~~~', 'After'])
})

test('a long fence is closed only by an equal-or-longer fence of the same char', () => {
  const markdown = '````\n```\n\nstill code\n````\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '````\n```\n\nstill code\n````',
    'After',
  ])
})

test('a tilde fence is not closed by backticks', () => {
  const markdown = '~~~\n```\n\ninside\n~~~\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['~~~\n```\n\ninside\n~~~', 'After'])
})

test('a fence lookalike inside an inline code span opens nothing', () => {
  const markdown = 'Open span `foo\n``` still text\nbar` done\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    'Open span `foo\n``` still text\nbar` done',
    'After',
  ])
})

test('a backtick fence whose info string contains a backtick is not a fence', () => {
  const markdown = '```a`b\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['```a`b', 'After'])
})

test('non-English and emoji content splits the same way', () => {
  const markdown = '# Zápis z porady 🎉\n\nPrvní odstavec — s pomlčkou.\n\n- položka'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '# Zápis z porady 🎉',
    'První odstavec — s pomlčkou.',
    '- položka',
  ])
})

test('an unclosed fence is closed for rendering with the same marker', () => {
  assert.equal(repairStreamingTail('```ts\nconst a ='), '```ts\nconst a =\n```')
  assert.equal(repairStreamingTail('~~~~\npartial'), '~~~~\npartial\n~~~~')
})

test('unbalanced emphasis is closed innermost-first', () => {
  assert.equal(repairStreamingTail('This is **bold and *ital'), 'This is **bold and *ital***')
  assert.equal(repairStreamingTail('A `code frag'), 'A `code frag`')
})

test('balanced emphasis and list bullets are left alone', () => {
  assert.equal(repairStreamingTail('* item with **bold** text'), '* item with **bold** text')
  assert.equal(repairStreamingTail('---'), '---')
  assert.equal(repairStreamingTail('```\ndone\n```'), '```\ndone\n```')
})

test('asterisks inside a closed code span are not emphasis', () => {
  assert.equal(repairStreamingTail('Use `a * b` here'), 'Use `a * b` here')
})
