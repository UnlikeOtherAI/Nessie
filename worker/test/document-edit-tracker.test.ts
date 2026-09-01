import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyDocumentEdits,
  createDocumentEditTracker,
  type EditSink,
} from '../src/run/execute/document-stream-edit.js'

const BASE = '# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n'

const recordingSink = () => {
  const steps: string[] = []
  const sink: EditSink = {
    beginEdit: ({ editIndex, offset, removeLength }) => {
      steps.push(`edit#${editIndex}@${offset}-${removeLength}`)
    },
    insert: ({ content, offset }) => {
      steps.push(`insert@${offset}:${content}`)
    },
  }
  return { sink, steps }
}

test('anchors an edit as soon as find closes, before any replacement text', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink, steps } = recordingSink()

  tracker.pump([{ find: 'Beta paragraph.', replace: '', replaceComplete: false }], sink)

  // The viewer can move to the change site with nothing to show there yet.
  assert.equal(steps.length, 1)
  assert.match(steps[0]!, /^edit#0@/)
  assert.equal(tracker.composed().includes('Beta paragraph.'), false)
})

test('streams replacement text into the anchored position', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink, steps } = recordingSink()

  tracker.pump([{ find: 'Beta paragraph.', replace: 'Beta ', replaceComplete: false }], sink)
  tracker.pump([{ find: 'Beta paragraph.', replace: 'Beta rewritten.', replaceComplete: true }], sink)

  assert.equal(tracker.composed(), BASE.replace('Beta paragraph.', 'Beta rewritten.'))
  assert.equal(steps.filter((step) => step.startsWith('insert@')).length, 2)
})

test('applies several edits in order, with offsets tracking earlier length changes', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink } = recordingSink()
  const edits = [
    { find: 'Alpha paragraph.', replace: 'A.', replaceComplete: true },
    { find: 'Gamma paragraph.', replace: 'Gamma paragraph, expanded a lot.', replaceComplete: true },
  ]
  tracker.pump(edits, sink)

  assert.equal(
    tracker.composed(),
    BASE
      .replace('Alpha paragraph.', 'A.')
      .replace('Gamma paragraph.', 'Gamma paragraph, expanded a lot.'),
  )
})

test('an empty replacement deletes the snippet', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink } = recordingSink()
  tracker.pump([{ find: '\n\nBeta paragraph.', replace: '', replaceComplete: true }], sink)
  assert.equal(tracker.composed().includes('Beta'), false)
  assert.equal(tracker.composed().includes('Alpha paragraph.'), true)
})

test('skips an anchor that matches more than once rather than guessing', () => {
  const tracker = createDocumentEditTracker('one\nrepeat\ntwo\nrepeat\n')
  const { sink, steps } = recordingSink()
  tracker.pump([{ find: 'repeat', replace: 'x', replaceComplete: true }], sink)
  assert.deepEqual(steps, [])
  assert.deepEqual(tracker.unanchored(), [0])
  assert.equal(tracker.composed(), 'one\nrepeat\ntwo\nrepeat\n')
})

test('skips an anchor that matches nothing and continues with later edits', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink } = recordingSink()
  tracker.pump(
    [
      { find: 'not present', replace: 'x', replaceComplete: true },
      { find: 'Alpha paragraph.', replace: 'A.', replaceComplete: true },
    ],
    sink,
  )
  assert.deepEqual(tracker.unanchored(), [0])
  assert.equal(tracker.composed(), BASE.replace('Alpha paragraph.', 'A.'))
})

test('waits for a partial find rather than anchoring on a prefix', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink, steps } = recordingSink()
  tracker.pump([{ find: null, replace: '', replaceComplete: false }], sink)
  assert.deepEqual(steps, [])
  assert.equal(tracker.composed(), BASE)
})

test('applyDocumentEdits agrees with the streamed result', () => {
  const tracker = createDocumentEditTracker(BASE)
  const { sink } = recordingSink()
  const edits = [
    { find: 'Alpha paragraph.', replace: 'Alpha, revised.', replaceComplete: true },
    { find: 'Gamma paragraph.', replace: '', replaceComplete: true },
  ]
  tracker.pump(edits, sink)
  const { applied } = applyDocumentEdits(
    BASE,
    edits.map((edit) => ({ find: edit.find!, replace: edit.replace })),
  )
  // The save path and the preview path are independent implementations; they
  // must land on the same document.
  assert.equal(applied, tracker.composed())
})

test('applyDocumentEdits refuses an ambiguous or missing anchor in words', () => {
  assert.throws(
    () => applyDocumentEdits('a\nrepeat\nb\nrepeat\n', [{ find: 'repeat', replace: 'x' }]),
    /more than once/,
  )
  assert.throws(
    () => applyDocumentEdits(BASE, [{ find: 'absent', replace: 'x' }]),
    /did not match/,
  )
})

test('handles non-Latin anchors and emoji replacements', () => {
  const base = '# Přehled\n\nPůvodní odstavec.\n\n完了 🎉\n'
  const tracker = createDocumentEditTracker(base)
  const { sink } = recordingSink()
  tracker.pump(
    [{ find: 'Původní odstavec.', replace: 'Nový odstavec — hotovo 🚀', replaceComplete: true }],
    sink,
  )
  assert.equal(tracker.composed(), base.replace('Původní odstavec.', 'Nový odstavec — hotovo 🚀'))
})
