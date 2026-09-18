import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { getStorage } from '../src/storage/index.js'

// The local blob store is configured with an ABSOLUTE path now, because it has
// to outlive the working tree the API happened to be started from
// (docs/standards/local-state.md). `getStorage` pasted `localPath` onto
// `process.cwd()` with `join`, which silently turns an absolute path into a
// path under the working directory — putting the store straight back inside
// the tree it was moved out of, and inventing a second one per checkout.

test('an absolute storage path is used as given, not re-anchored on the cwd', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nessie-storage-'))
  t.after(async () => { await rm(base, { force: true, recursive: true }) })

  const storage = getStorage({ localPath: base, provider: 'filesystem' })
  const written = await storage.putStream(
    'agents/core.md',
    Readable.from([Buffer.from('canonical bytes')]),
    { mime: 'text/markdown' },
  )

  assert.equal(written.bytesWritten, 15)
  // Straight off the filesystem: the bytes are under the absolute base, and
  // nothing was created beneath the working directory.
  assert.equal(await readFile(join(base, 'agents/core.md'), 'utf8'), 'canonical bytes')
})

test('a relative storage path still resolves against the working directory', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nessie-storage-cwd-'))
  const previous = process.cwd()
  process.chdir(base)
  t.after(async () => {
    process.chdir(previous)
    await rm(base, { force: true, recursive: true })
  })

  const storage = getStorage({ localPath: '.nessie/storage', provider: 'filesystem' })
  await storage.putStream(
    'note.txt',
    Readable.from([Buffer.from('relative')]),
    { mime: 'text/plain' },
  )

  assert.equal(await readFile(join(base, '.nessie/storage/note.txt'), 'utf8'), 'relative')
})
