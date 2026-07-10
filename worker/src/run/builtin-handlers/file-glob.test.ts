import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runFileGlob } from './file-glob.js'
import { SandboxViolationError } from './sandbox.js'
import { createSymlinkOrSkip } from './test-symlink.js'

const setup = async (): Promise<{
  root: string
  cleanup: () => Promise<void>
}> => {
  const created = await mkdtemp(join(tmpdir(), 'nessie-file-glob-'))
  const root = await realpath(created)
  await mkdir(join(root, 'src', 'inner'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'x')
  await writeFile(join(root, 'src', 'b.ts'), 'x')
  await writeFile(join(root, 'src', 'inner', 'c.ts'), 'x')
  await writeFile(join(root, 'src', 'readme.md'), 'x')
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('runFileGlob globs inside the allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    const result = await runFileGlob(
      { pattern: '**/*.ts', cwd: root },
      { allowedRoots: [root] },
    )

    assert.equal(result.cwd, root)
    assert.equal(result.truncated, false)
    const sorted = [...result.matches].sort()
    assert.deepEqual(sorted, [
      join(root, 'src', 'a.ts'),
      join(root, 'src', 'b.ts'),
      join(root, 'src', 'inner', 'c.ts'),
    ])
  } finally {
    await cleanup()
  }
})

test('runFileGlob defaults cwd to the first allowed root', async () => {
  const { root, cleanup } = await setup()
  try {
    const result = await runFileGlob(
      { pattern: 'src/*.ts' },
      { allowedRoots: [root] },
    )

    assert.equal(result.cwd, root)
    assert.equal(result.matches.length, 2)
  } finally {
    await cleanup()
  }
})

test('runFileGlob rejects a cwd outside allowedRoots', async () => {
  const { root, cleanup } = await setup()
  try {
    await assert.rejects(
      runFileGlob(
        { pattern: '*.ts', cwd: '/tmp' },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('runFileGlob rejects a cwd that escapes via ..', async () => {
  const { root, cleanup } = await setup()
  try {
    await assert.rejects(
      runFileGlob(
        { pattern: '*.ts', cwd: join(root, '..') },
        { allowedRoots: [root] },
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('runFileGlob refuses when allowedRoots is empty', async () => {
  await assert.rejects(
    runFileGlob({ pattern: '**/*' }, { allowedRoots: [] }),
    SandboxViolationError,
  )
})

test('runFileGlob skips matches reached via a symlink that escapes the root', async (t) => {
  const { root, cleanup } = await setup()
  const escapeTarget = await mkdtemp(join(tmpdir(), 'nessie-file-glob-out-'))
  try {
    await writeFile(join(escapeTarget, 'secret.ts'), 'x')
    const linked = await createSymlinkOrSkip(
      t,
      escapeTarget,
      join(root, 'src', 'escape'),
      'dir',
    )
    if (!linked) {
      return
    }

    const result = await runFileGlob(
      { pattern: '**/*.ts', cwd: root },
      { allowedRoots: [root] },
    )

    for (const match of result.matches) {
      assert.equal(
        match.startsWith(`${root}/`),
        true,
        `match ${match} escaped root ${root}`,
      )
    }
    assert.equal(
      result.matches.some((match) => match.includes('secret.ts')),
      false,
    )
  } finally {
    await rm(escapeTarget, { recursive: true, force: true })
    await cleanup()
  }
})

test('runFileGlob respects the limit and reports truncation', async () => {
  const { root, cleanup } = await setup()
  try {
    const result = await runFileGlob(
      { pattern: '**/*.ts', limit: 1 },
      { allowedRoots: [root] },
    )

    assert.equal(result.matches.length, 1)
    assert.equal(result.truncated, true)
  } finally {
    await cleanup()
  }
})
