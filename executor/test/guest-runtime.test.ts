import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGuestWorkspaceLease, releaseGuestWorkspaceLease } from '../src/guest-workspace-lease.js'
import { runGuestVmHandshake } from '../src/guest-vm-handshake.js'
import {
  materializeGuestRuntimeBundle,
  removeGuestRuntimeBundleSnapshot,
  verifyGuestRuntimeBundle,
} from '../src/guest-runtime-bundle.js'
import { startGuestVmSession } from '../src/guest-vm-session.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'

test('a guest COW lease is exact-run, path-derived, and fences sandbox teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-guest-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-guest-state-'))
  const runId = '00000000-0000-4000-8000-000000000109'
  try {
    await writeFile(join(root, 'base.txt'), 'host source')
    const lease = await createGuestWorkspaceLease(stateDir, root, {
      bindingFence: '1',
      commandId: '00000000-0000-4000-8000-000000000110',
      runId,
    })
    assert.equal(lease.runId, runId)
    assert.notEqual(lease.workspace, await realpath(root))
    assert.equal(await readFile(join(lease.workspace, 'base.txt'), 'utf8'), 'host source')
    await assert.rejects(stopSandboxWorkspace(stateDir, runId), /active guest lease/)
    await assert.rejects(
      releaseGuestWorkspaceLease(stateDir, { ...lease, leaseId: '00000000-0000-4000-8000-000000000000' }),
      /does not match/,
    )
    await releaseGuestWorkspaceLease(stateDir, lease)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('the VM handshake receives only a current COW lease and passes its token through stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-vm-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-vm-state-'))
  const runId = '00000000-0000-4000-8000-000000000111'
  const builderPath = join(stateDir, 'builder')
  const helperPath = join(stateDir, 'helper')
  const kernelPath = join(stateDir, 'kernel')
  try {
    await writeFile(join(root, 'base.txt'), 'host source')
    await Promise.all([
      writeFile(builderPath, 'builder'),
      writeFile(helperPath, 'helper'),
      writeFile(kernelPath, 'kernel'),
    ])
    await Promise.all([chmod(builderPath, 0o700), chmod(helperPath, 0o700), chmod(kernelPath, 0o600)])
    const lease = await createGuestWorkspaceLease(stateDir, root, {
      bindingFence: '1',
      commandId: '00000000-0000-4000-8000-000000000112',
      runId,
    })
    const calls: Array<{ argv: string[]; input: string; path: string }> = []
    await runGuestVmHandshake({
      guestInitrdBuilderPath: builderPath,
      kernelPath,
      lease,
      stateDir,
      vmHelperPath: helperPath,
    }, {
      runProcess: async (call) => { calls.push(call) },
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path, await realpath(builderPath))
    assert.deepEqual(calls[0].argv.slice(-1), ['--bootstrap-token-stdin'])
    assert.equal(calls[0].argv.includes(calls[0].input), false)
    assert.equal(calls[1].path, await realpath(helperPath))
    assert.equal(calls[1].input, calls[0].input)
    assert.equal(calls[1].argv.includes(lease.workspace), true)
    await assert.rejects(releaseGuestWorkspaceLease(stateDir, lease), /unavailable/)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('guest runtime bundles pin every browser and coding artifact without host fallback', async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'nessie-guest-runtime-'))
  const snapshotParent = await mkdtemp(join(tmpdir(), 'nessie-guest-runtime-snapshot-'))
  const browserPath = join(bundle, 'bin', 'browser')
  const tmuxPath = join(bundle, 'bin', 'tmux')
  const codexPath = join(bundle, 'bin', 'codex')
  try {
    await mkdir(join(bundle, 'bin'), { mode: 0o700 })
    await chmod(join(bundle, 'bin'), 0o700)
    await Promise.all([
      writeFile(browserPath, 'browser-runtime'),
      writeFile(tmuxPath, 'managed-tmux'),
      writeFile(codexPath, 'managed-codex'),
    ])
    await Promise.all([chmod(browserPath, 0o700), chmod(tmuxPath, 0o700), chmod(codexPath, 0o700)])
    const manifest = {
      entrypoints: { browser: 'bin/browser', codex: 'bin/codex', tmux: 'bin/tmux' },
      files: [
        { executable: true, path: 'bin/browser', sha256: createHash('sha256').update('browser-runtime').digest('hex') },
        { executable: true, path: 'bin/codex', sha256: createHash('sha256').update('managed-codex').digest('hex') },
        { executable: true, path: 'bin/tmux', sha256: createHash('sha256').update('managed-tmux').digest('hex') },
      ],
      version: 1,
    }
    await writeFile(join(bundle, 'nessie-guest-runtime.json'), JSON.stringify(manifest))
    await chmod(join(bundle, 'nessie-guest-runtime.json'), 0o600)
    const verified = await verifyGuestRuntimeBundle(bundle)
    assert.equal(verified.root, bundle)
    assert.equal(verified.entrypoints.browser, 'bin/browser')
    assert.equal(verified.entrypoints.tmux, 'bin/tmux')
    const snapshot = await materializeGuestRuntimeBundle(verified, join(snapshotParent, 'runtime'))
    assert.equal(await readFile(join(snapshot.root, 'bin', 'codex'), 'utf8'), 'managed-codex')
    await assert.rejects(writeFile(join(snapshot.root, 'bin', 'codex'), 'replaced'), /EACCES/)
    await writeFile(codexPath, 'tampered')
    assert.equal(await readFile(join(snapshot.root, 'bin', 'codex'), 'utf8'), 'managed-codex')
    await assert.rejects(verifyGuestRuntimeBundle(bundle), /integrity check failed/)
    await assert.rejects(
      materializeGuestRuntimeBundle(verified, join(snapshotParent, 'changed-runtime')),
      /integrity check failed/,
    )
    await writeFile(join(bundle, 'nessie-guest-runtime.json'), JSON.stringify({
      ...manifest,
      entrypoints: { ...manifest.entrypoints, hidden: 'bin/codex' },
    }))
    await assert.rejects(verifyGuestRuntimeBundle(bundle), /manifest is malformed/)
    await removeGuestRuntimeBundleSnapshot(snapshot.root)
  } finally {
    await rm(bundle, { force: true, recursive: true })
    await rm(snapshotParent, { force: true, recursive: true })
  }
})

test('a guest VM session mounts a private runtime snapshot and keeps its token out of argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-session-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-session-state-'))
  const runId = '00000000-0000-4000-8000-000000000121'
  const builderPath = join(stateDir, 'builder')
  const helperPath = join(stateDir, 'helper')
  const kernelPath = join(stateDir, 'kernel')
  const runtimeBundlePath = join(stateDir, 'guest-runtime')
  try {
    await writeFile(join(root, 'base.txt'), 'host source')
    await Promise.all([
      writeFile(builderPath, 'builder'),
      writeFile(helperPath, 'helper'),
      writeFile(kernelPath, 'kernel'),
    ])
    await Promise.all([chmod(builderPath, 0o700), chmod(helperPath, 0o700), chmod(kernelPath, 0o600)])
    await mkdir(join(runtimeBundlePath, 'bin'), { mode: 0o700, recursive: true })
    await chmod(runtimeBundlePath, 0o700)
    const browserRuntime = 'browser-runtime'
    await writeFile(join(runtimeBundlePath, 'bin', 'browser'), browserRuntime)
    await chmod(join(runtimeBundlePath, 'bin', 'browser'), 0o700)
    await writeFile(join(runtimeBundlePath, 'nessie-guest-runtime.json'), JSON.stringify({
      entrypoints: { browser: 'bin/browser' },
      files: [{ executable: true, path: 'bin/browser', sha256: createHash('sha256').update(browserRuntime).digest('hex') }],
      version: 1,
    }))
    await chmod(join(runtimeBundlePath, 'nessie-guest-runtime.json'), 0o600)
    const lease = await createGuestWorkspaceLease(stateDir, root, {
      bindingFence: '1',
      commandId: '00000000-0000-4000-8000-000000000122',
      runId,
    })
    const calls: Array<{ argv: string[]; input: string; path: string }> = []
    let resolveClosed: (() => void) | undefined
    const session = await startGuestVmSession({
      egressPolicy: { allowedOrigins: ['https://app.example.test'] },
      guestInitrdBuilderPath: builderPath,
      guestRuntimeBundlePath: runtimeBundlePath,
      kernelPath,
      lease,
      stateDir,
      vmHelperPath: helperPath,
    }, {
      runProcess: async (call) => { calls.push(call) },
      launchProcess: async (call) => {
        calls.push(call)
        return {
          closed: new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise }),
	          closeCodingSession: async () => {},
	          inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
	          launchCodingSession: async () => {},
	          observeCodingSession: async () => ({ agent: 'codex' as const, lifecycle: 'running' as const, output: '' }),
          observeBrowser: async () => ({ targets: [{ title: 'Guide', type: 'page' as const, url: 'https://app.example.test/guide' }] }),
          openBrowser: async (url) => {
            assert.equal(url, 'https://app.example.test/guide')
          },
          stop: async () => { resolveClosed?.() },
        }
      },
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path, await realpath(builderPath))
    assert.deepEqual(calls[0].argv.slice(-1), ['--bootstrap-token-stdin'])
    assert.equal(calls[1].path, await realpath(helperPath))
    assert.equal(calls[1].input, calls[0].input)
    assert.equal(calls[1].argv[0], 'session')
    assert.equal(calls[1].argv.includes(lease.workspace), true)
    const runtimeBundleIndex = calls[1].argv.indexOf('--runtime-bundle')
    assert.equal(runtimeBundleIndex >= 0, true)
    const mountedRuntime = calls[1].argv[runtimeBundleIndex + 1]!
    assert.notEqual(mountedRuntime, runtimeBundlePath)
    assert.equal(await readFile(join(mountedRuntime, 'bin', 'browser'), 'utf8'), browserRuntime)
    await writeFile(join(runtimeBundlePath, 'bin', 'browser'), 'changed-source-runtime')
    assert.equal(await readFile(join(mountedRuntime, 'bin', 'browser'), 'utf8'), browserRuntime)
    const runtimeDigestIndex = calls[1].argv.indexOf('--runtime-manifest-digest')
    assert.equal(runtimeDigestIndex >= 0, true)
    assert.match(calls[1].argv[runtimeDigestIndex + 1]!, /^sha256:[a-f0-9]{64}$/)
    assert.equal(calls[1].argv.includes(calls[1].input), false)
    const gatewayIndex = calls[1].argv.indexOf('--egress-gateway')
    assert.equal(gatewayIndex >= 0, true)
    assert.match(calls[1].argv[gatewayIndex + 1]!, /egress\.sock$/)
    assert.deepEqual(await session.inspectRuntime(), { browser: true, claude: false, codex: false, tmux: false })
    await session.openBrowser('https://app.example.test/guide')
    await assert.rejects(session.openBrowser('https://blocked.example.test/'), /not allowed by local policy/)
    assert.deepEqual(await session.observeBrowser(), {
      targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
    })
    await session.stop()
    await session.closed
    await assert.rejects(releaseGuestWorkspaceLease(stateDir, lease), /unavailable/)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
