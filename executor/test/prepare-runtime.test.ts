import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { nodeExecutableName, nodeLicensePath, prepareExecutorRuntime } from '../scripts/prepare-runtime.mjs'
import { collectExecutorRuntimeFacts, verifyExecutorRuntime } from '../src/runtime-integrity.js'

const ENTRY_POINT = new URL('../src/index.ts', import.meta.url).pathname

const digest = async (path: string): Promise<string> => (
  createHash('sha256').update(await readFile(path)).digest('hex')
)

test('the shared preparation writes the exact runtime layout both supervisors verify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-'))
  try {
    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      outputDirectory: join(directory, 'executor-runtime'),
    })

    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.format, 1)
    assert.equal(manifest.nodeVersion, process.versions.node)
    assert.equal(manifest.nodeExecutable, nodeExecutableName(process.platform))
    assert.equal(manifest.nodeSha256, await digest(prepared.nodePath))
    assert.equal(manifest.executorBundleSha256, await digest(prepared.executorBundlePath))
    assert.equal(manifest.nativeHelper, undefined)
    if (process.platform !== 'win32') {
      assert.equal((await lstat(prepared.nodePath)).mode & 0o111, 0o111)
    }
    assert.ok((await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8')).length > 0)
    assert.match(await readFile(prepared.executorBundlePath, 'utf8'), /nessie-executor/)

    // The producer and the verifier agree by construction, not by two
    // constants happening to match: ownership is a packaged-install rule, so
    // the staging copy is verified under the non-Linux arm.
    const facts = await collectExecutorRuntimeFacts(prepared.runtimeDirectory)
    assert.deepEqual(verifyExecutorRuntime({ ...facts, platform: 'darwin' }), { ok: true })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

/**
 * Both layouts are produced from one host by injecting the platform and a Node
 * path laid out the way that platform lays it out — the test never branches on
 * `process.platform`, so the Windows layout is exercised on Linux CI and the
 * POSIX layout on a Windows build machine.
 */
test('the Windows layout ships node.exe and the licence installed beside it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-windows-'))
  try {
    // A Windows Node install: `node.exe` and `LICENSE` in the same directory.
    const nodeHome = join(directory, 'nodejs')
    await mkdir(nodeHome, { recursive: true })
    const nodeExecutablePath = join(nodeHome, 'node.exe')
    await writeFile(nodeExecutablePath, 'windows-node-binary')
    await writeFile(join(nodeHome, 'LICENSE'), 'node license')
    const helperSourcePath = join(directory, 'nessie-executor-native.exe')
    await writeFile(helperSourcePath, 'windows-native-helper')

    assert.equal(nodeLicensePath(nodeExecutablePath, 'win32'), join(nodeHome, 'LICENSE'))

    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nativeHelperPath: helperSourcePath,
      nodeExecutablePath,
      outputDirectory: join(directory, 'executor-runtime'),
      platform: 'win32',
    })

    assert.equal(prepared.nodePath, join(prepared.runtimeDirectory, 'node.exe'))
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.format, 1)
    assert.equal(manifest.nodeExecutable, 'node.exe')
    assert.equal(manifest.nodeSha256, await digest(prepared.nodePath))
    assert.equal(manifest.nativeHelper, 'nessie-executor-native.exe')
    assert.equal(
      manifest.nativeHelperSha256,
      await digest(join(prepared.runtimeDirectory, 'nessie-executor-native.exe')),
    )
    assert.equal(await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8'), 'node license')

    const facts = await collectExecutorRuntimeFacts(prepared.runtimeDirectory)
    assert.deepEqual(verifyExecutorRuntime({ ...facts, platform: 'win32' }), { ok: true })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('the POSIX layout reads the licence one directory above the Node binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-posix-'))
  try {
    // A POSIX Node install: `bin/node` with `LICENSE` at the prefix root.
    const nodeExecutablePath = join(directory, 'nodejs', 'bin', 'node')
    await mkdir(dirname(nodeExecutablePath), { recursive: true })
    await writeFile(nodeExecutablePath, 'posix-node-binary')
    await writeFile(join(directory, 'nodejs', 'LICENSE'), 'node license')

    assert.equal(nodeLicensePath(nodeExecutablePath, 'linux'), join(directory, 'nodejs', 'LICENSE'))

    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nodeExecutablePath,
      outputDirectory: join(directory, 'executor-runtime'),
      platform: 'linux',
    })

    assert.equal(prepared.nodePath, join(prepared.runtimeDirectory, 'node'))
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.nodeExecutable, 'node')
    assert.equal((await lstat(prepared.nodePath)).mode & 0o111, 0o111)
    assert.equal(await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8'), 'node license')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('a Node install with no licence beside it stops the build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-licence-'))
  try {
    const nodeExecutablePath = join(directory, 'nodejs', 'node.exe')
    await mkdir(dirname(nodeExecutablePath), { recursive: true })
    await writeFile(nodeExecutablePath, 'windows-node-binary')

    await assert.rejects(
      prepareExecutorRuntime({
        entryPoint: ENTRY_POINT,
        nodeExecutablePath,
        outputDirectory: join(directory, 'executor-runtime'),
        platform: 'win32',
      }),
      /Unable to locate the Node\.js license/,
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
