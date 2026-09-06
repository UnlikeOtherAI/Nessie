import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyDocumentDelta,
  applyDocumentEdit,
  createDocumentStreamEntry,
  mergeBootstrap,
  type DocumentStreamEntry,
} from '../src/facades/threads/document-stream-entries'

/**
 * The server and the client apply the same edits with different code. This
 * replays the exact event sequence the worker emits and asserts the client
 * lands on the worker's document — the one property that decides whether a
 * person is watching the file they will actually get.
 *
 * The server's rule (worker/src/run/execute/document-stream-edit.ts): locate
 * `find` in the composed document, remove it, publish the edit, then insert the
 * replacement in pieces at an advancing offset.
 */
const emitServerEvents = (
  base: string,
  edits: { find: string; replace: string }[],
  chunk = 7,
) => {
  const events: (
    | { kind: 'edit'; editIndex: number; offset: number; removeLength: number }
    | { kind: 'delta'; content: string; offset: number; seq: number }
  )[] = []
  let composed = base
  let seq = 0

  edits.forEach((edit, editIndex) => {
    const offset = composed.indexOf(edit.find)
    assert.notEqual(offset, -1, `anchor ${editIndex} must exist`)
    composed = composed.slice(0, offset) + composed.slice(offset + edit.find.length)
    events.push({ editIndex, kind: 'edit', offset, removeLength: edit.find.length })

    let written = 0
    while (written < edit.replace.length) {
      const content = edit.replace.slice(written, written + chunk)
      const at = offset + written
      composed = composed.slice(0, at) + content + composed.slice(at)
      seq += 1
      events.push({ content, kind: 'delta', offset: at, seq })
      written += content.length
    }
  })

  return { composed, events }
}

const replayOnClient = (base: string, events: ReturnType<typeof emitServerEvents>['events']) => {
  let entry: DocumentStreamEntry = mergeBootstrap(
    createDocumentStreamEntry({ runId: 'run-1', sessionId: 'session-1' }),
    { lastSeq: 0, markdown: base, offset: base.length },
  ).entry

  for (const event of events) {
    if (event.kind === 'edit') {
      const applied = applyDocumentEdit(entry, {
        editIndex: event.editIndex,
        offset: event.offset,
        removeLength: event.removeLength,
      })
      assert.equal(applied.outcome, 'applied', `edit ${event.editIndex} must apply`)
      entry = applied.entry
      continue
    }
    const applied = applyDocumentDelta(entry, {
      content: event.content,
      offset: event.offset,
      seq: event.seq,
    })
    assert.equal(applied.outcome, 'applied', `delta ${event.seq} must apply`)
    entry = applied.entry
  }
  return entry
}

const HANDBOOK = [
  '# Team Handbook',
  '',
  '## Working hours',
  '',
  'We work roughly nine to five, and we are flexible about it.',
  '',
  '## Deployment',
  '',
  'We deploy on Fridays, which has never once caused a problem.',
  '',
  '## Support rota',
  '',
  'One person is on call each week.',
  '',
  '## Onboarding',
  '',
  'New joiners get a buddy for their first month.',
  '',
].join('\n')

test('the client reproduces the server document for a single mid-document edit', () => {
  const edits = [{
    find: 'We deploy on Fridays, which has never once caused a problem.',
    replace: 'We deploy Monday through Thursday, with a rollback plan written down.',
  }]
  const { composed, events } = emitServerEvents(HANDBOOK, edits)
  const entry = replayOnClient(HANDBOOK, events)
  assert.equal(entry.markdown, composed)
})

test('the client reproduces the server document across several edits', () => {
  // The second anchor sits after the first, so its offset depends on the first
  // edit having changed the document's length identically on both sides.
  const edits = [
    {
      find: 'We deploy on Fridays, which has never once caused a problem.',
      replace: 'We deploy Monday through Thursday. Friday deploys need a second reviewer.',
    },
    {
      find: 'One person is on call each week.',
      replace: 'Two people share each on-call week: a primary and a backup. 🎯',
    },
  ]
  const { composed, events } = emitServerEvents(HANDBOOK, edits)
  const entry = replayOnClient(HANDBOOK, events)
  assert.equal(entry.markdown, composed)
  assert.equal(entry.markdown.includes('One person is on call each week.'), false)
  assert.equal(entry.markdown.includes('primary and a backup'), true)
  assert.equal(entry.markdown.includes('New joiners get a buddy'), true)
})

test('a shrinking edit followed by a later edit still agrees', () => {
  const edits = [
    { find: 'We work roughly nine to five, and we are flexible about it.', replace: 'Flexible.' },
    { find: 'New joiners get a buddy for their first month.', replace: 'Buddy for a month.' },
  ]
  const { composed, events } = emitServerEvents(HANDBOOK, edits)
  assert.equal(replayOnClient(HANDBOOK, events).markdown, composed)
})

test('a deletion agrees', () => {
  const edits = [{ find: '\n\n## Support rota\n\nOne person is on call each week.', replace: '' }]
  const { composed, events } = emitServerEvents(HANDBOOK, edits)
  const entry = replayOnClient(HANDBOOK, events)
  assert.equal(entry.markdown, composed)
  assert.equal(entry.markdown.includes('Support rota'), false)
})

test('tiny provider chunks do not change the outcome', () => {
  const edits = [{
    find: 'One person is on call each week.',
    replace: 'Two people share each on-call week — a primary and a backup. 🎯 完了',
  }]
  const { composed, events } = emitServerEvents(HANDBOOK, edits, 1)
  assert.equal(replayOnClient(HANDBOOK, events).markdown, composed)
})

test('a snapshot bootstrap does not double-apply frames it already contains', () => {
  // An edit session's durable lane stores a *snapshot* of the composed
  // document, not a log — so a snapshot read mid-stream already contains the
  // deltas published before it. Replaying those buffered frames on top would
  // write the same text twice.
  const edits = [{
    find: 'One person is on call each week.',
    replace: 'Two people share each on-call week.',
  }]
  const { composed, events } = emitServerEvents(HANDBOOK, edits, 9)

  // Server state after every event: what a snapshot read now would contain.
  const snapshotAfterAll = composed
  const lastSeq = events.filter((event) => event.kind === 'delta').length

  const entry = mergeBootstrap(
    createDocumentStreamEntry({ runId: 'run-1', sessionId: 'session-1' }),
    { lastSeq, markdown: snapshotAfterAll, offset: snapshotAfterAll.length },
    events.map((event) => (event.kind === 'edit'
      ? { edit: { editIndex: event.editIndex, offset: event.offset, removeLength: event.removeLength }, kind: 'edit' as const }
      : { delta: { content: event.content, offset: event.offset, seq: event.seq }, kind: 'delta' as const })),
    { snapshot: true },
  )

  assert.equal(entry.entry.markdown, composed)
  // Frames it could not place are not lost: the caller reads again.
  assert.equal(entry.needsRefetch, true)
})
