import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runFileGlob } from './file-glob.js'
import { SandboxViolationError } from './sandbox.js'

const setup = async (): Promise<{
  root: string
  cleanup: () => Promise<void>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-file-glob-'))
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
