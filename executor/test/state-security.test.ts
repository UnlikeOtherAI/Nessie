import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  assertOwnerOnlyStatePath,
  ensureOwnerOnlyStateDirectory,
  packagedNativeHelperPath,
  spawnPackagedStateSecurityHelper,
  type StateSecurityCommand,
} from '../src/state-security.js'

type HelperCall = { command: StateSecurityCommand; path: string }

/**
 * A stand-in for the packaged Win32 helper. The point of injecting it is that
 * the Windows dispatch — which paths are secured, which are verified, and that
 * no mode bit is ever consulted — is proved on any host.
 */
const recordingHelper = (calls: HelperCall[], reject?: string) => async (
  command: StateSecurityCommand,
  path: string,
): Promise<void> => {
  calls.push({ command, path })
  if (reject) throw new Error(reject)
}

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-state-security-'))
  try {
    await body(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

test('POSIX proves privacy from ownership and mode bits, and never calls the helper', async () => {
  await withDirectory(async (directory) => {
    const calls: HelperCall[] = []
    const deps = { helper: recordingHelper(calls), platform: 'linux' as NodeJS.Platform }
    const stateDir = join(directory, 'executors', 'one')

    const created = await ensureOwnerOnlyStateDirectory(stateDir, deps)
    assert.equal(created, stateDir)
    await assertOwnerOnlyStatePath(stateDir, 'directory', deps)

    const file = join(stateDir, 'executor-state.json')
    await writeFile(file, '{}', { mode: 0o600 })
    await assertOwnerOnlyStatePath(file, 'file', deps)

    assert.deepEqual(calls, [])
  })
})

test('a POSIX state path readable by the group or the world is refused', async () => {
  await withDirectory(async (directory) => {
    const deps = { helper: recordingHelper([]), platform: 'linux' as NodeJS.Platform }
    const stateDir = join(directory, 'executors', 'one')
    await ensureOwnerOnlyStateDirectory(stateDir, deps)

    const file = join(stateDir, 'executor-state.json')
    await writeFile(file, '{}', { mode: 0o640 })
    await assert.rejects(
      assertOwnerOnlyStatePath(file, 'file', deps),
      /must not be accessible by other users/,
    )

    await chmod(stateDir, 0o755)
    await assert.rejects(
      assertOwnerOnlyStatePath(stateDir, 'directory', deps),
      /must not be accessible by other users/,
    )
  })
})

test('Windows secures and verifies the directory through the helper, reading no mode bits', async () => {
  await withDirectory(async (directory) => {
    const calls: HelperCall[] = []
    const deps = { helper: recordingHelper(calls), platform: 'win32' as NodeJS.Platform }
    const stateDir = join(directory, 'executors', 'one')
    // The real helper creates the directory; the fake does not, so the test
    // makes it exist the way Windows would find it afterwards.
    await mkdir(stateDir, { recursive: true })
    // A world-open mode is exactly what Node reports on Windows. It must not
    // influence the verdict there — the DACL the helper reads is the answer.
    await chmod(stateDir, 0o777)

    await ensureOwnerOnlyStateDirectory(stateDir, deps)
    await assertOwnerOnlyStatePath(stateDir, 'directory', deps)

    assert.deepEqual(calls, [
      { command: 'secure-directory', path: stateDir },
      { command: 'verify-owner-only', path: stateDir },
    ])
  })
})

test('a Windows lease file is proved by the directory whose DACL it inherits', async () => {
  await withDirectory(async (directory) => {
    const calls: HelperCall[] = []
    const deps = { helper: recordingHelper(calls), platform: 'win32' as NodeJS.Platform }
    const stateDir = join(directory, 'executors', 'one')
    await mkdir(stateDir, { recursive: true })
    const lease = join(stateDir, 'daemon.pid')
    await writeFile(lease, '4242\n', { mode: 0o666 })

    await assertOwnerOnlyStatePath(lease, 'file', deps)
    assert.deepEqual(calls, [{ command: 'verify-owner-only', path: stateDir }])
  })
})

test('a helper that refuses fails the check closed on Windows', async () => {
  await withDirectory(async (directory) => {
    const deps = {
      helper: recordingHelper([], 'Executor state path is not owner-only (EXECUTOR_STATE_SECURITY_REJECTED).'),
      platform: 'win32' as NodeJS.Platform,
    }
    const stateDir = join(directory, 'executors', 'one')
    await mkdir(stateDir, { recursive: true })

    await assert.rejects(
      assertOwnerOnlyStatePath(stateDir, 'directory', deps),
      /EXECUTOR_STATE_SECURITY_REJECTED/,
    )
    await assert.rejects(ensureOwnerOnlyStateDirectory(stateDir, deps), /EXECUTOR_STATE_SECURITY_REJECTED/)
  })
})

test('a symlinked or wrongly-shaped state path is refused on either host', async () => {
  await withDirectory(async (directory) => {
    const stateDir = join(directory, 'executors', 'one')
    await mkdir(stateDir, { recursive: true })
    const target = join(stateDir, 'real.json')
    await writeFile(target, '{}', { mode: 0o600 })
    const link = join(stateDir, 'link.json')
    await symlink(target, link)

    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const deps = { helper: recordingHelper([]), platform }
      await assert.rejects(
        assertOwnerOnlyStatePath(link, 'file', deps),
        /must be an ordinary file/,
        `${platform} must refuse a symlinked state file`,
      )
      await assert.rejects(
        assertOwnerOnlyStatePath(target, 'directory', deps),
        /must be an ordinary directory/,
        `${platform} must refuse a file where a directory is required`,
      )
    }
  })
})

test('a Windows run with no packaged runtime fails closed and names the remedy', async () => {
  const previous = process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  try {
    await assert.rejects(
      spawnPackagedStateSecurityHelper('verify-owner-only', join(tmpdir(), 'executors', 'one')),
      /packaged native helper/,
    )
  } finally {
    if (previous === undefined) delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
    else process.env.NESSIE_EXECUTOR_PACKAGED_CLI = previous
  }
})

test('the helper is resolved from the packaged runtime directory, never from PATH', () => {
  const resolved = packagedNativeHelperPath()
  assert.equal(resolved, join(dirname(process.execPath), 'nessie-executor-native.exe'))
})
