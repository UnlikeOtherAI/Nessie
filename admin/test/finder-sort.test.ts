import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks'
import {
  composeFinderSort,
  familyForRow,
  FINDER_SORTS,
  finderSortDirection,
  finderSortKey,
  kindLabelForRow,
  sortFinderRows,
} from '../src/components/features/knowledge/finder/finder-sort'

/**
 * The Finder's ordering (browser-ui.md §6). These are the rules a person
 * notices the moment they are wrong: a folder that sinks into the middle of
 * the file list, `file10` before `file2`, or a column that reshuffles itself
 * every time one row's `updatedAt` ticks.
 */

const page = (
  overrides: Partial<KnowledgePageRecord> & { id: string; title: string },
): KnowledgePageRecord => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'document',
  labels: [],
  latestVersion: null,
  metadata: null,
  parentPageId: null,
  policyChainTrace: [],
  position: 0,
  publishedVersion: null,
  publishedVersionId: null,
  sourceRef: 'test',
  spaceId: 'space-1',
  status: 'published',
  summary: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  visibilityReason: 'test',
  ...overrides,
})

const titles = (rows: KnowledgePageRecord[]): string[] => rows.map((row) => row.title)

test('the ten sort values are a key and a direction, and round-trip', () => {
  assert.equal(FINDER_SORTS.length, 10)
  for (const sort of FINDER_SORTS) {
    assert.equal(composeFinderSort(finderSortKey(sort), finderSortDirection(sort)), sort)
  }
})

test('folders come first in both directions', () => {
  const rows = [
    page({ id: 'a', title: 'Apple.pdf' }),
    page({ id: 'b', kind: 'folder', title: 'Zebra' }),
    page({ id: 'c', title: 'Banana.pdf' }),
    page({ id: 'd', kind: 'folder', title: 'Alpha' }),
  ]

  assert.deepEqual(
    titles(sortFinderRows(rows, 'name')),
    ['Alpha', 'Zebra', 'Apple.pdf', 'Banana.pdf'],
  )
  // Descending flips inside each group; it never lets a file above a folder.
  assert.deepEqual(
    titles(sortFinderRows(rows, 'name-desc')),
    ['Zebra', 'Alpha', 'Banana.pdf', 'Apple.pdf'],
  )
})

test('names sort numerically, so file2 comes before file10', () => {
  const rows = [
    page({ id: 'a', title: 'file10.txt' }),
    page({ id: 'b', title: 'file2.txt' }),
    page({ id: 'c', title: 'file1.txt' }),
  ]
  assert.deepEqual(
    titles(sortFinderRows(rows, 'name')),
    ['file1.txt', 'file2.txt', 'file10.txt'],
  )
})

test('an unknown size sorts last in both directions', () => {
  const rows = [
    page({ id: 'a', sizeBytes: '100', title: 'small.bin' }),
    page({ id: 'b', sizeBytes: null, title: 'unsized.doc' }),
    page({ id: 'c', sizeBytes: '900', title: 'big.bin' }),
  ]
  assert.deepEqual(titles(sortFinderRows(rows, 'size')), ['small.bin', 'big.bin', 'unsized.doc'])
  assert.deepEqual(titles(sortFinderRows(rows, 'size-desc')), ['big.bin', 'small.bin', 'unsized.doc'])
})

test('the order is total: equal keys break on position, then id', () => {
  const rows = [
    page({ id: 'z', position: 1, title: 'Same', updatedAt: '2026-02-01T00:00:00.000Z' }),
    page({ id: 'a', position: 1, title: 'Same', updatedAt: '2026-02-01T00:00:00.000Z' }),
    page({ id: 'm', position: 0, title: 'Same', updatedAt: '2026-02-01T00:00:00.000Z' }),
  ]
  assert.deepEqual(sortFinderRows(rows, 'name').map((row) => row.id), ['m', 'a', 'z'])
  // …and the same input sorted twice gives the same answer, which is what
  // stops a column appearing to shuffle on every refetch.
  assert.deepEqual(
    sortFinderRows(sortFinderRows(rows, 'modified'), 'modified').map((row) => row.id),
    ['m', 'a', 'z'],
  )
})

test('sortFinderRows does not mutate its input', () => {
  const rows = [page({ id: 'b', title: 'B' }), page({ id: 'a', title: 'A' })]
  sortFinderRows(rows, 'name')
  assert.deepEqual(titles(rows), ['B', 'A'])
})

test('a row’s family is its kind, then its filename', () => {
  assert.equal(familyForRow({ kind: 'folder', title: 'anything.pdf' }), 'folder')
  assert.equal(familyForRow({ kind: 'document', title: 'Notes' }), 'document')
  assert.equal(familyForRow({ kind: 'file', title: 'Lease.pdf' }), 'pdf')
  // Markdown opens as a real document here, so it takes the document glyph
  // rather than a grey "text file" one.
  assert.equal(familyForRow({ kind: 'file', title: 'README.md' }), 'document')
  assert.equal(familyForRow({ kind: 'file', title: 'mystery' }), 'unknown')
})

test('Kind sorts by the label a person reads, then by name', () => {
  const rows = [
    page({ id: 'a', kind: 'file', title: 'b.pdf' }),
    page({ id: 'b', kind: 'file', title: 'a.png' }),
    page({ id: 'c', kind: 'file', title: 'a.pdf' }),
  ]
  assert.equal(kindLabelForRow(rows[0] as KnowledgePageRecord), 'PDF document')
  // "Image" before "PDF document"; within PDF, a before b.
  assert.deepEqual(titles(sortFinderRows(rows, 'kind')), ['a.png', 'a.pdf', 'b.pdf'])
})
