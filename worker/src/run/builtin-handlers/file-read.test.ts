import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runFileRead } from './file-read.js'
import { SandboxViolationError } from './sandbox.js'

const setup = async (): Promise<{
  root: string
  cleanup: () => Promise<void>
}> => {
  const created = await mkdtemp(join(tmpdir(), 'nessie-file-read-'))
  const root = await realpath(created)
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('runFileRead reads a file inside the allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'note.txt')
    await writeFile(target, 'hello sandbox', 'utf8')

    const result = await runFileRead(
      { path: target },
      { allowedRoots: [root] },
    )

    assert.equal(result.path, target)
    assert.equal(result.encoding, 'utf8')
    assert.equal(result.content, 'hello sandbox')
    assert.equal(result.truncated, false)
  } finally {
    await cleanup()
  }
})

test('runFileRead rejects a path outside the allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    await assert.rejects(
      runFileRead(
        { path: '/etc/hosts' },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('runFileRead rejects `..` traversal that escapes the root', async () => {
  const { root, cleanup } = await setup()
  try {
    const escaping = join(root, '..', 'escaped.txt')
    await assert.rejects(
      runFileRead(
        { path: escaping },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('runFileRead refuses when allowedRoots is empty', async () => {
  await assert.rejects(
    runFileRead({ path: '/tmp/foo' }, { allowedRoots: [] }),
    SandboxViolationError,
  )
})

test('runFileRead refuses when transportConfig is missing', async () => {
  await assert.rejects(
    runFileRead({ path: '/tmp/foo' }, undefined),
    SandboxViolationError,
  )
})

test('runFileRead rejects a symlink that points outside the allowed root', async () => {
  const { root, cleanup } = await setup()
  const escapeTarget = await mkdtemp(join(tmpdir(), 'nessie-file-read-out-'))
  try {
    const secret = join(escapeTarget, 'secret.txt')
    await writeFile(secret, 'leak', 'utf8')

    const linkPath = join(root, 'link.txt')
    await symlink(secret, linkPath)

    await assert.rejects(
      runFileRead({ path: linkPath }, { allowedRoots: [root] }),
      SandboxViolationError,
    )
  } finally {
    await rm(escapeTarget, { recursive: true, force: true })
    await cleanup()
  }
})

test('runFileRead truncates output when file exceeds maxBytes', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'big.txt')
    await writeFile(target, 'a'.repeat(200), 'utf8')

    const result = await runFileRead(
      { path: target, maxBytes: 50 },
      { allowedRoots: [root] },
    )

    assert.equal(result.bytesRead, 50)
    assert.equal(result.truncated, true)
    assert.equal(result.content.length, 50)
  } finally {
    await cleanup()
  }
})
