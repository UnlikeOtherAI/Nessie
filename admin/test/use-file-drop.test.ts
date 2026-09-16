import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DIRECTORIES_UNSUPPORTED_COPY,
  DROP_REFUSAL_COPY,
  MAX_DROP_BYTES,
  MAX_DROP_ENTRIES,
  readDroppedItems,
} from '../src/hooks/useFileDrop.js'
import { dropZoneLabel } from '../src/components/shared/DropZoneOverlay.js'

/**
 * What a drop carries, and what it refuses
 * (docs/plans/2026-09-16-documents-finder-ui/uploads-and-indexing.md §1).
 *
 * The walk is the part with real failure modes: `readEntries` answers in
 * batches and lies about being done unless it is called until it answers an
 * empty one, a browser without the entry API reports a folder as a zero-byte
 * file, and a mistaken drop of a home directory has to be refused before the
 * first byte rather than 40 000 uploads later.
 */

type Entry = {
  createReader?: () => { readEntries: (ok: (entries: Entry[]) => void, fail: () => void) => void }
  file?: (ok: (file: File) => void, fail: () => void) => void
  isDirectory: boolean
  isFile: boolean
  name: string
}

const fakeFile = (name: string, size = 10): File =>
  ({ name, size, type: 'text/plain' }) as unknown as File

const fileEntry = (name: string, size = 10): Entry => ({
  file: (ok) => ok(fakeFile(name, size)),
  isDirectory: false,
  isFile: true,
  name,
})

// A directory that hands its children out in batches of two and only then
// answers empty — the shape the real API has and the shape a single
// `readEntries` call silently truncates.
const directoryEntry = (name: string, children: Entry[], batch = 2): Entry => {
  let cursor = 0
  return {
    createReader: () => ({
      readEntries: (ok) => {
        const slice = children.slice(cursor, cursor + batch)
        cursor += slice.length
        ok(slice)
      },
    }),
    isDirectory: true,
    isFile: false,
    name,
  }
}

const items = (entries: Entry[]): DataTransferItem[] =>
  entries.map(
    (entry) =>
      ({ kind: 'file', webkitGetAsEntry: () => entry }) as unknown as DataTransferItem,
  )

test('a plain file drop keeps every file, with no folder path', async () => {
  const drop = await readDroppedItems(items([fileEntry('a.txt'), fileEntry('b.pdf')]), [])
  assert.equal(drop.refusal, null)
  assert.deepEqual(
    drop.entries.map((entry) => [entry.file.name, entry.relativePath]),
    [
      ['a.txt', []],
      ['b.pdf', []],
    ],
  )
  assert.equal(drop.directoriesUnsupported, false)
})

// The failure this is written against: `readEntries` is documented to be
// called repeatedly, and a reader that calls it once uploads the first two
// files of a folder and quietly drops the rest.
test('a dropped folder is read to the end, not to the end of its first batch', async () => {
  const folder = directoryEntry('Contracts', [
    fileEntry('one.txt'),
    fileEntry('two.txt'),
    fileEntry('three.txt'),
    fileEntry('four.txt'),
    fileEntry('five.txt'),
  ])
  const drop = await readDroppedItems(items([folder]), [])
  assert.deepEqual(
    drop.entries.map((entry) => entry.file.name),
    ['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt'],
  )
  for (const entry of drop.entries) {
    assert.deepEqual(entry.relativePath, ['Contracts'])
  }
})

test('a nested folder carries the path it came from', async () => {
  const folder = directoryEntry('Contracts', [
    fileEntry('lease.pdf'),
    directoryEntry('2026', [fileEntry('draft.md')]),
  ])
  const drop = await readDroppedItems(items([folder]), [])
  assert.deepEqual(
    drop.entries.map((entry) => [entry.file.name, entry.relativePath]),
    [
      ['lease.pdf', ['Contracts']],
      ['draft.md', ['Contracts', '2026']],
    ],
  )
})

// Without the entry API a folder and an empty file are the same thing on the
// wire, so the folder is dropped — with a sentence, never in silence.
test('a browser without the entry API drops the folders and says so', async () => {
  const folderShapedFile = { name: 'Contracts', size: 0, type: '' } as unknown as File
  const drop = await readDroppedItems([], [fakeFile('a.txt'), folderShapedFile])
  assert.deepEqual(
    drop.entries.map((entry) => entry.file.name),
    ['a.txt'],
  )
  assert.equal(drop.directoriesUnsupported, true)
  assert.equal(
    DIRECTORIES_UNSUPPORTED_COPY,
    "Folders can't be dropped in this browser — drop the files inside them.",
  )
  const clean = await readDroppedItems([], [fakeFile('a.txt')])
  assert.equal(clean.directoriesUnsupported, false)
})

test('over the count cap nothing starts at all', async () => {
  const many = Array.from({ length: MAX_DROP_ENTRIES + 1 }, (_, index) =>
    fileEntry(`f${index}.txt`),
  )
  const drop = await readDroppedItems(items([directoryEntry('Home', many, 50)]), [])
  assert.equal(drop.refusal?.code, 'too_many')
  assert.equal(drop.refusal?.message, DROP_REFUSAL_COPY.too_many)
  assert.deepEqual(drop.entries, [], 'a refused drop uploads nothing, not the first 500')
})

test('exactly the count cap is accepted', async () => {
  const many = Array.from({ length: MAX_DROP_ENTRIES }, (_, index) => fileEntry(`f${index}.txt`))
  const drop = await readDroppedItems(items([directoryEntry('Home', many, 50)]), [])
  assert.equal(drop.refusal, null)
  assert.equal(drop.entries.length, MAX_DROP_ENTRIES)
})

test('over the total-bytes cap nothing starts either', async () => {
  const half = Math.ceil(MAX_DROP_BYTES / 2) + 1
  const drop = await readDroppedItems(
    items([fileEntry('a.mov', half), fileEntry('b.mov', half)]),
    [],
  )
  assert.equal(drop.refusal?.code, 'too_large')
  assert.equal(drop.refusal?.message, DROP_REFUSAL_COPY.too_large)
  assert.deepEqual(drop.entries, [])
  assert.equal(MAX_DROP_BYTES, 5 * 1024 ** 3)
})

test('a file the walk cannot open is skipped, not thrown', async () => {
  const broken: Entry = {
    file: (_ok, fail) => fail(),
    isDirectory: false,
    isFile: true,
    name: 'gone.txt',
  }
  const drop = await readDroppedItems(items([broken, fileEntry('a.txt')]), [])
  assert.deepEqual(
    drop.entries.map((entry) => entry.file.name),
    ['a.txt'],
  )
})

test('an entry that is neither a file nor a directory is ignored', async () => {
  const odd = { isDirectory: false, isFile: false, name: 'weird' } as Entry
  const drop = await readDroppedItems(items([odd]), [])
  assert.deepEqual(drop.entries, [])
})

// The overlay names the target and, once the count is known, the count. A
// template with a hole in it ("Drop 0 files into …") is what this prevents.
test('the overlay reads as a whole sentence at every stage of a drag', () => {
  assert.equal(dropZoneLabel({}), 'Drop the file here')
  assert.equal(dropZoneLabel({ destination: 'Contracts' }), 'Drop to upload into Contracts')
  assert.equal(
    dropZoneLabel({ count: 5, destination: 'Contracts' }),
    'Drop 5 files into Contracts',
  )
  assert.equal(
    dropZoneLabel({ count: 1, destination: 'Contracts' }),
    'Drop 1 file into Contracts',
  )
  assert.equal(dropZoneLabel({ count: 0, destination: 'Contracts' }), 'Drop to upload into Contracts')
  assert.equal(dropZoneLabel({ count: 3 }), 'Drop 3 files here')
})
