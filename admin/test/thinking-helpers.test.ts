import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendThinkingEntry,
  countThinkingEntries,
  groupPendingByRoot,
  mergeThinkingEntries,
  reconcileThreadThinking,
  selectPendingForRoot,
  toThinkingBlocks,
  toThinkingLines,
  type PendingStreamMessage,
  type ThinkingEntry,
  type ThreadThinkingRun,
} from '../src/facades/threads/thinking.js'

const reasoning = (id: string, content: string): ThinkingEntry => ({
  content,
  id,
  kind: 'reasoning',
})

const tool = (id: string, content: string): ThinkingEntry => ({
  content,
  id,
  kind: 'tool',
})

const pending = (overrides: Partial<PendingStreamMessage> = {}): PendingStreamMessage => ({
  agentId: 'agent-1',
  content: '',
  rootMessageId: null,
  runId: 'run-1',
  thinking: [],
  ...overrides,
})

const bootstrapRun = (overrides: Partial<ThreadThinkingRun> = {}): ThreadThinkingRun => ({
  agentId: 'agent-1',
  entries: [],
  lastChunkId: null,
  rootMessageId: null,
  runId: 'run-1',
  startedAt: '2026-08-05T10:00:00.000Z',
  ...overrides,
})

test('toThinkingBlocks joins consecutive reasoning flushes into one passage', () => {
  // The recorder flushes on size/time, never on sentence boundaries.
  const blocks = toThinkingBlocks([
    reasoning('1', 'Checking the sche'),
    reasoning('2', 'ma for the reply anchor.'),
    tool('3', 'kb_search: reply anchor'),
    reasoning('4', 'Found it.'),
  ])

  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [
      ['reasoning', 'Checking the schema for the reply anchor.'],
      ['tool', 'kb_search: reply anchor'],
      ['reasoning', 'Found it.'],
    ],
  )
})

test('toThinkingLines splits reasoning on newlines and keeps tool lines whole', () => {
  const lines = toThinkingLines([
    reasoning('1', 'first line\n\nsecond line\n'),
    tool('2', 'web_search: où est le rapport'),
  ])

  assert.deepEqual(
    lines.map((line) => [line.kind, line.text]),
    [
      ['reasoning', 'first line'],
      ['reasoning', 'second line'],
      ['tool', 'web_search: où est le rapport'],
    ],
  )
})

test('toThinkingLines keeps only the tail and gives every line a distinct key', () => {
  const lines = toThinkingLines([reasoning('1', 'a\nb\nc\nd\ne'), tool('2', 'run_task: x')], 3)

  assert.deepEqual(
    lines.map((line) => line.text),
    ['d', 'e', 'run_task: x'],
  )
  assert.equal(new Set(lines.map((line) => line.key)).size, 3)
})

test('toThinkingLines survives entries without chunk ids', () => {
  const lines = toThinkingLines([
    { content: 'no id here', kind: 'reasoning' },
    { content: 'tool_call: y', kind: 'tool' },
  ])

  assert.deepEqual(
    lines.map((line) => line.text),
    ['no id here', 'tool_call: y'],
  )
  assert.equal(new Set(lines.map((line) => line.key)).size, 2)
})

test('appendThinkingEntry ignores a chunk that is already present', () => {
  const entries = [reasoning('10', 'first')]
  const appended = appendThinkingEntry(entries, reasoning('11', 'second'))
  assert.equal(appended.length, 2)

  // Same reference back, so a duplicate never triggers a re-render.
  assert.equal(appendThinkingEntry(appended, reasoning('11', 'second')), appended)
})

test('mergeThinkingEntries dedupes by chunk id and restores durable order', () => {
  // The live tail arrived first; the fetched history fills in the older prefix.
  const merged = mergeThinkingEntries(
    [reasoning('9', 'ninth'), reasoning('10', 'tenth')],
    [reasoning('8', 'eighth'), reasoning('9', 'ninth'), reasoning('10', 'tenth')],
  )

  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['8', '9', '10'],
  )
})

test('mergeThinkingEntries orders numerically, not lexicographically', () => {
  const merged = mergeThinkingEntries([reasoning('100', 'hundred')], [reasoning('99', 'ninety-nine')])

  assert.deepEqual(
    merged.map((entry) => entry.id),
    ['99', '100'],
  )
})

test('mergeThinkingEntries keeps arrival order when a chunk id is missing', () => {
  const merged = mergeThinkingEntries(
    [{ content: 'live', kind: 'reasoning' }],
    [reasoning('1', 'fetched')],
  )

  assert.deepEqual(
    merged.map((entry) => entry.content),
    ['live', 'fetched'],
  )
})

test('reconcileThreadThinking seeds runs the client never saw start', () => {
  const reconciled = reconcileThreadThinking(
    [],
    [
      bootstrapRun({
        entries: [
          { content: 'mid-run thought', createdAt: '2026-08-05T10:00:01.000Z', id: '5', kind: 'reasoning' },
        ],
        rootMessageId: 'msg-root',
        runId: 'run-late',
      }),
    ],
  )

  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0]?.runId, 'run-late')
  assert.equal(reconciled[0]?.rootMessageId, 'msg-root')
  assert.equal(reconciled[0]?.seededFromBootstrap, true)
  assert.deepEqual(
    reconciled[0]?.thinking.map((entry) => entry.content),
    ['mid-run thought'],
  )
})

test('reconcileThreadThinking merges the bootstrap tail into a known run', () => {
  const reconciled = reconcileThreadThinking(
    [pending({ content: 'partial reply', thinking: [reasoning('5', 'seen live')] })],
    [
      bootstrapRun({
        entries: [
          { content: 'seen live', createdAt: '2026-08-05T10:00:01.000Z', id: '5', kind: 'reasoning' },
          { content: 'missed chunk', createdAt: '2026-08-05T10:00:02.000Z', id: '6', kind: 'tool' },
        ],
      }),
    ],
  )

  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0]?.content, 'partial reply')
  assert.equal(reconciled[0]?.seededFromBootstrap, undefined)
  assert.deepEqual(
    reconciled[0]?.thinking.map((entry) => entry.id),
    ['5', '6'],
  )
})

test('reconcileThreadThinking drops runs the bootstrap no longer reports', () => {
  const reconciled = reconcileThreadThinking([pending({ runId: 'run-zombie' })], [])
  assert.deepEqual(reconciled, [])
})

test('reconcileThreadThinking keeps a run that started after the request went out', () => {
  const reconciled = reconcileThreadThinking(
    [pending({ runId: 'run-fresh' })],
    [],
    new Set(['run-fresh']),
  )

  assert.deepEqual(
    reconciled.map((entry) => entry.runId),
    ['run-fresh'],
  )
})

test('selectPendingForRoot returns only the runs anchored to that root', () => {
  const entries = [
    pending({ rootMessageId: 'root-a', runId: 'run-a' }),
    pending({ rootMessageId: 'root-b', runId: 'run-b' }),
    pending({ rootMessageId: null, runId: 'run-top' }),
  ]

  assert.deepEqual(
    selectPendingForRoot(entries, 'root-a').map((entry) => entry.runId),
    ['run-a'],
  )
  assert.deepEqual(selectPendingForRoot(entries, null), [])
  assert.deepEqual(selectPendingForRoot(entries, undefined), [])
})

test('groupPendingByRoot indexes thread-anchored runs and skips top-level ones', () => {
  const grouped = groupPendingByRoot([
    pending({ rootMessageId: 'root-a', runId: 'run-a' }),
    pending({ rootMessageId: 'root-a', runId: 'run-a2' }),
    pending({ rootMessageId: null, runId: 'run-top' }),
  ])

  assert.deepEqual(
    grouped.get('root-a')?.map((entry) => entry.runId),
    ['run-a', 'run-a2'],
  )
  assert.equal(grouped.size, 1)
})

test('countThinkingEntries totals the ticker growth across runs', () => {
  assert.equal(
    countThinkingEntries([
      pending({ runId: 'run-a', thinking: [reasoning('1', 'a'), tool('2', 'b')] }),
      pending({ runId: 'run-b', thinking: [reasoning('3', 'c')] }),
    ]),
    3,
  )
})
