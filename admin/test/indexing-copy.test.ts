import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeIndexingState } from '@nessie/schemas'
import {
  hasPendingIndexing,
  indexingCopy,
  MAX_INDEXABLE_LABEL,
} from '../src/components/features/knowledge/finder/indexing-copy'

/**
 * The one rule this file exists for: **the screen never shows a spinner that
 * cannot resolve** (uploads-and-indexing.md §4).
 *
 * Three of the five states are terminal and honest — a draft has no chunks and
 * will not until somebody publishes it, an image is never extracted, a file
 * over the worker's ceiling is refused before a job is enqueued — and each one
 * must say so in words, not spin. The two that do spin are the two jobs that
 * are actually running.
 */

// Every member of the union, spelled out rather than generated, so a state
// added to the schema shows up here as a case nobody wrote a sentence for.
const EVERY_STATE: KnowledgeIndexingState[] = [
  { state: 'not_applicable' },
  { state: 'indexed', versionId: '00000000-0000-4000-8000-000000000001' },
  { stage: 'extract', state: 'pending' },
  { stage: 'embed', state: 'pending' },
  { reason: 'draft', state: 'not_indexed' },
  { reason: 'unsupported', state: 'not_indexed' },
  { reason: 'too_large', state: 'not_indexed' },
  { reason: 'empty', state: 'not_indexed' },
  { stage: 'extract', state: 'failed' },
  { stage: 'embed', state: 'failed' },
]

test('only the two running jobs spin', () => {
  const spinning = EVERY_STATE
    .filter((state) => indexingCopy(state).spin)
    .map((state) => JSON.stringify(state))

  assert.deepEqual(spinning, [
    JSON.stringify({ stage: 'extract', state: 'pending' }),
    JSON.stringify({ stage: 'embed', state: 'pending' }),
  ])
})

test('a draft says why it is not indexed, and never spins', () => {
  const draft = indexingCopy({ reason: 'draft', state: 'not_indexed' })

  // Documents are chunked on publish. A draft row that claimed to be indexing
  // would be claiming a job exists; none does, and none will.
  assert.equal(draft.spin, false)
  assert.equal(draft.pending, false)
  assert.equal(
    draft.sentence,
    'Not indexed — draft documents are indexed when published',
  )
  // No glyph: the status pill already says "draft", and a second marker for
  // the same fact is noise on the most common row in a personal folder.
  assert.equal(draft.glyph, 'none')
  assert.equal(draft.icon, null)
})

test('a file the pipeline will never read says which kind it is', () => {
  assert.equal(
    indexingCopy({ reason: 'unsupported', state: 'not_indexed' }, 'Image').sentence,
    "Not indexed — Images aren't searchable",
  )
  assert.equal(
    indexingCopy({ reason: 'unsupported', state: 'not_indexed' }, 'Spreadsheet').sentence,
    "Not indexed — Spreadsheets aren't searchable",
  )
  // Without a family word the sentence still has to be a sentence.
  assert.equal(
    indexingCopy({ reason: 'unsupported', state: 'not_indexed' }).sentence,
    "Not indexed — this kind of file isn't searchable",
  )
  assert.equal(indexingCopy({ reason: 'unsupported', state: 'not_indexed' }).glyph, 'not-indexed')
})

test('the size ceiling is the worker constant, rendered once', () => {
  assert.equal(MAX_INDEXABLE_LABEL, '20 MB')
  assert.equal(
    indexingCopy({ reason: 'too_large', state: 'not_indexed' }).sentence,
    'Not indexed — larger than 20 MB',
  )
})

test('the quiet states are quiet, and the working ones name their stage', () => {
  assert.deepEqual(
    EVERY_STATE.filter((state) => indexingCopy(state).glyph === 'none').map((s) => s.state),
    ['not_applicable', 'indexed', 'not_indexed'],
  )
  assert.equal(indexingCopy({ state: 'not_applicable' }).sentence, '')
  assert.equal(
    indexingCopy({ state: 'indexed', versionId: '00000000-0000-4000-8000-000000000001' }).sentence,
    'Searchable',
  )
  assert.equal(indexingCopy({ stage: 'extract', state: 'pending' }).sentence, 'Indexing…')
  assert.equal(indexingCopy({ stage: 'embed', state: 'pending' }).sentence, 'Preparing search…')
  assert.equal(indexingCopy({ reason: 'empty', state: 'not_indexed' }).sentence, 'Not indexed — no text found')
})

test('only a failed row offers a retry, and it is the only warning glyph', () => {
  const retryable = EVERY_STATE.filter((state) => indexingCopy(state).retry)
  assert.equal(retryable.length, 2)
  for (const state of retryable) {
    assert.equal(state.state, 'failed')
    assert.equal(indexingCopy(state).sentence, 'Indexing failed')
    assert.equal(indexingCopy(state).tone, '--warning')
  }
})

test('every state produces a copy — none falls through to nothing', () => {
  for (const state of EVERY_STATE) {
    const copy = indexingCopy(state, 'Image')
    assert.equal(typeof copy.sentence, 'string')
    assert.ok(['none', 'pending', 'not-indexed', 'failed'].includes(copy.glyph))
    // A glyph without a sentence is a mark nobody can read.
    if (copy.glyph !== 'none') assert.ok(copy.sentence.length > 0)
  }
})

test('the poll runs for pending rows and for nothing else', () => {
  assert.equal(hasPendingIndexing([]), false)
  assert.equal(hasPendingIndexing([{ indexing: { reason: 'draft', state: 'not_indexed' } }]), false)
  // A row from a listing that predates the enrichment must not start a poll
  // that can never stop.
  assert.equal(hasPendingIndexing([{}]), false)
  assert.equal(hasPendingIndexing([
    { indexing: { reason: 'draft', state: 'not_indexed' } },
    { indexing: { stage: 'embed', state: 'pending' } },
  ]), true)
})
