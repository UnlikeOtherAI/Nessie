import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import test from 'node:test'

import { loadConfig } from '../src/index.js'

// Where local mode keeps uploaded bytes.
//
// It used to be `.nessie/storage`, resolved against the working directory, and
// that had two faults at once. It sat inside the working tree, which
// `git worktree remove` deletes as a matter of routine; and it was per-tree
// while the database every tree talks to is shared, so a row written from one
// checkout named bytes no other checkout could read. Both are one property:
// the store has to be absolute, and outside the repository.
//
// docs/standards/local-state.md.

test('the local storage path is absolute and outside the checkout', () => {
  const config = loadConfig({ cwd: process.cwd(), env: {} })
  const localPath = config.storage.localPath

  assert.ok(localPath, 'local mode configures a filesystem store')
  assert.ok(isAbsolute(localPath), `expected an absolute path, got "${localPath}"`)
  assert.ok(
    localPath.startsWith(homedir()),
    `expected a path under ${homedir()}, got "${localPath}"`,
  )
  // The repository root, from packages/config/test.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
  assert.ok(
    !localPath.startsWith(repoRoot),
    `the store must not live inside the checkout (${repoRoot}), got "${localPath}"`,
  )
})

test('an explicit storage path still wins', () => {
  const config = loadConfig({
    cwd: process.cwd(),
    env: { NESSIE_STORAGE_LOCAL_PATH: '/srv/nessie/blobs' },
  })

  assert.equal(config.storage.localPath, '/srv/nessie/blobs')
})
