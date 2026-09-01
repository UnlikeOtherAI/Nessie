import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { prepareExecutorRuntime } from '../scripts/prepare-runtime.mjs'
import { collectExecutorRuntimeFacts, verifyExecutorRuntime } from '../src/runtime-integrity.js'

const digest = async (path: string): Promise<string> => (
  createHash('sha256').update(await readFile(path)).digest('hex')
)

test('the shared preparation writes the exact runtime layout both supervisors verify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-'))
  try {
    const prepared = await prepareExecutorRuntime({
      entryPoint: new URL('../src/index.ts', import.meta.url).pathname,
      outputDirectory: join(directory, 'executor-runtime'),
    })

    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.format, 1)
    assert.equal(manifest.nodeVersion, process.versions.node)
    assert.equal(manifest.nodeSha256, await digest(prepared.nodePath))
    assert.equal(manifest.executorBundleSha256, await digest(prepared.executorBundlePath))
    assert.equal((await lstat(prepared.nodePath)).mode & 0o111, 0o111)
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
