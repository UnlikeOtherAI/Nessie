import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileWriteOverwriteError, runFileWrite } from './file-write.js'
import { SandboxViolationError } from './sandbox.js'

const setup = async (): Promise<{
  root: string
  cleanup: () => Promise<void>
}> => {
  const created = await mkdtemp(join(tmpdir(), 'nessie-file-write-'))
  const root = await realpath(created)
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('runFileWrite writes a new file inside the allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'created.txt')
    const result = await runFileWrite(
      { path: target, content: 'fresh' },
      { allowedRoots: [root] },
    )

    assert.equal(result.path, target)
    assert.equal(result.bytesWritten, 5)
    assert.equal(result.created, true)
    assert.equal(await readFile(target, 'utf8'), 'fresh')
  } finally {
    await cleanup()
  }
})

test('runFileWrite rejects a destination outside the allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    await assert.rejects(
      runFileWrite(
        { path: '/tmp/outside-root.txt', content: 'nope' },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('runFileWrite refuses to overwrite without overwrite=true', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'exists.txt')
    await writeFile(target, 'old', 'utf8')

    await assert.rejects(
      runFileWrite(
        { path: target, content: 'new' },
        { allowedRoots: [root] },
      ),
      FileWriteOverwriteError,
    )

    assert.equal(await readFile(target, 'utf8'), 'old')
  } finally {
    await cleanup()
  }
})

test('runFileWrite overwrites when overwrite=true', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'exists.txt')
    await writeFile(target, 'old', 'utf8')

    const result = await runFileWrite(
      { path: target, content: 'new', overwrite: true },
      { allowedRoots: [root] },
    )

    assert.equal(result.created, false)
    assert.equal(await readFile(target, 'utf8'), 'new')
  } finally {
    await cleanup()
  }
})

test('runFileWrite creates parent directories when createParents=true', async () => {
  const { root, cleanup } = await setup()
  try {
    const target = join(root, 'nested', 'deep', 'file.txt')
    const result = await runFileWrite(
      {
        path: target,
        content: 'deep',
        createParents: true,
      },
      { allowedRoots: [root] },
    )

    assert.equal(result.bytesWritten, 4)
    assert.equal(await readFile(target, 'utf8'), 'deep')
  } finally {
    await cleanup()
  }
})

test('runFileWrite rejects a symlinked destination that escapes the root', async () => {
  const { root, cleanup } = await setup()
  const escapeTarget = await mkdtemp(join(tmpdir(), 'nessie-file-write-out-'))
  try {
    const outside = join(escapeTarget, 'secret.txt')
    await writeFile(outside, 'old', 'utf8')

    const linkPath = join(root, 'link.txt')
    await symlink(outside, linkPath)

    await assert.rejects(
      runFileWrite(
        { path: linkPath, content: 'leak', overwrite: true },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )

    assert.equal(await readFile(outside, 'utf8'), 'old')
  } finally {
    await rm(escapeTarget, { recursive: true, force: true })
    await cleanup()
  }
})

test('runFileWrite refuses when allowedRoots is empty', async () => {
  await assert.rejects(
    runFileWrite(
      { path: '/tmp/foo.txt', content: 'no' },
      { allowedRoots: [] },
    ),
    SandboxViolationError,
  )
})
