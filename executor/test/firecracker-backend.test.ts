import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFirecrackerBackend, guestBootArgs } from '../src/firecracker/index.js'
import { newGuestVmSessionId, type GuestVmBackendStartInput } from '../src/guest-vm-backend.js'
import { createFakeFirecracker } from './firecracker-fake.js'

const ROOT_PROBE = { getgid: () => 0, getuid: () => 0 }

const stageRuntime = async (): Promise<{
  firecrackerPath: string
  input: (token: string, egressPath?: string) => GuestVmBackendStartInput
  root: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-firecracker-'))
  const resources = join(root, 'resources')
  await mkdir(resources, { mode: 0o700, recursive: true })
  const firecrackerPath = join(resources, 'firecracker')
  await writeFile(firecrackerPath, '#!/bin/sh\n')
  await writeFile(join(resources, 'jailer'), '#!/bin/sh\n')
  await chmod(firecrackerPath, 0o700)
  await chmod(join(resources, 'jailer'), 0o700)
  const kernelPath = join(root, 'vmlinux')
  const initrdPath = join(root, 'initrd')
  await writeFile(kernelPath, 'kernel')
  await writeFile(initrdPath, 'initrd')
  const sessionDirectory = join(root, 'session')
  await mkdir(sessionDirectory, { mode: 0o700, recursive: true })
  return {
    firecrackerPath,
    input: (bootstrapToken, egressGatewaySocketPath) => ({
      bootstrapToken,
      consolePath: join(sessionDirectory, 'console'),
      ...(egressGatewaySocketPath ? { egressGatewaySocketPath } : {}),
      initrdPath,
      kernelPath,
      readyTimeoutMs: 10_000,
      resources: { memoryMiB: 4_096, vcpuCount: 2 },
      runtimeManifestDigest: `sha256:${'a'.repeat(64)}`,
      runtimeSnapshotPath: join(sessionDirectory, 'runtime'),
      sessionDirectory,
      sessionId: newGuestVmSessionId(),
      vmHelperPath: firecrackerPath,
      workspacePath: join(sessionDirectory, 'work'),
    }),
    root,
  }
}

test('the Firecracker backend configures, boots, serves the guest, and leaves no jail behind', async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({
    bootstrapToken,
    runtimeDirectory: staged.root,
  })
  try {
    const backend = createFirecrackerBackend({ privilegeProbe: ROOT_PROBE, spawnProcess })
    assert.equal(backend.kind, 'firecracker')
    const started = staged.input(bootstrapToken)
    const session = await backend.start(started)

    // The jailer is argv, never a shell string, and carries the daemon identity.
    assert.equal(fake.jailerPath, join(staged.root, 'resources', 'jailer'))
    assert.deepEqual(fake.jailerArgv, [
      '--id', started.sessionId,
      '--exec-file', staged.firecrackerPath,
      '--uid', '0',
      '--gid', '0',
      '--chroot-base-dir', fake.chrootBaseDirectory,
      '--cgroup-version', '2',
      '--',
      '--api-sock', '/firecracker.socket',
    ])
    assert.equal(fake.jailerArgv.some((value) => /[;&|]/.test(value)), false)

    // The exact configuration sequence, and no network interface at all.
    assert.deepEqual(fake.calls.map((call) => call.path), [
      '/boot-source',
      '/machine-config',
      '/vsock',
      '/actions',
    ])
    assert.deepEqual(fake.calls[0].body, {
      boot_args: guestBootArgs({ egress: false, runtimeManifestDigest: started.runtimeManifestDigest }),
      initrd_path: '/initrd.cpio',
      kernel_image_path: '/vmlinux',
    })
    assert.deepEqual(fake.calls[1].body, {
      mem_size_mib: 4_096,
      smt: false,
      track_dirty_pages: false,
      vcpu_count: 2,
    })
    assert.deepEqual(fake.calls[2].body, { guest_cid: 3, uds_path: '/v.sock' })
    assert.deepEqual(fake.calls[3].body, { action_type: 'InstanceStart' })

    // The boot images were staged inside the jail, as the jailer requires.
    assert.equal((await stat(join(fake.chrootDirectory, 'vmlinux'))).isFile(), true)
    assert.equal((await stat(join(fake.chrootDirectory, 'initrd.cpio'))).isFile(), true)

    // The guest's own frames reach the shared control client unchanged.
    assert.deepEqual(await session.inspectRuntime(), {
      browser: true,
      claude: false,
      codex: true,
      tmux: true,
    })

    await session.stop()
    // Graceful stop asks for SendCtrlAltDel before the process tree is killed.
    assert.deepEqual(fake.calls.at(-1)?.body, { action_type: 'SendCtrlAltDel' })
    await assert.rejects(stat(fake.chrootBaseDirectory), /ENOENT/)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a session with forced egress boots with the egress flag and both guest channels listening', async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({
    bootstrapToken,
    runtimeDirectory: staged.root,
  })
  const gatewayDirectory = await mkdtemp(join(tmpdir(), 'nessie-egress-'))
  try {
    const backend = createFirecrackerBackend({ privilegeProbe: ROOT_PROBE, spawnProcess })
    const started = staged.input(bootstrapToken, join(gatewayDirectory, 'egress.sock'))
    const session = await backend.start(started)
    const bootArgs = (fake.calls[0].body as { boot_args: string }).boot_args
    assert.equal(bootArgs.includes('nessie.egress=1'), true)
    assert.equal(bootArgs.includes('rdinit=/init'), true)
    assert.equal(bootArgs.includes('console=ttyS0'), true)
    assert.equal((await stat(join(fake.chrootDirectory, 'v.sock_49152'))).isSocket(), true)
    assert.equal((await stat(join(fake.chrootDirectory, 'v.sock_49153'))).isSocket(), true)
    await session.stop()
  } finally {
    await fake.stop()
    await rm(gatewayDirectory, { force: true, recursive: true })
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a guest that never presents its control hello fails the session closed and cleans the jail', async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({
    bootGuest: false,
    bootstrapToken,
    runtimeDirectory: staged.root,
  })
  try {
    const backend = createFirecrackerBackend({ privilegeProbe: ROOT_PROBE, spawnProcess })
    const started = { ...staged.input(bootstrapToken), readyTimeoutMs: 250 }
    await assert.rejects(backend.start(started), /executor/i)
    await assert.rejects(stat(fake.chrootBaseDirectory), /ENOENT/)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a guest presenting the wrong bootstrap token is refused before any control byte is served', async () => {
  const staged = await stageRuntime()
  const bootstrapToken = randomBytes(32).toString('base64url')
  const { fake, spawnProcess } = createFakeFirecracker({
    // The guest speaks a well-formed hello carrying somebody else's token.
    bootstrapToken: randomBytes(32).toString('base64url'),
    runtimeDirectory: staged.root,
  })
  try {
    const backend = createFirecrackerBackend({ privilegeProbe: ROOT_PROBE, spawnProcess })
    const started = { ...staged.input(bootstrapToken), readyTimeoutMs: 2_000 }
    await assert.rejects(backend.start(started), /control authentication|timed out/i)
  } finally {
    await fake.stop()
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('an unprivileged daemon is refused at session start with the remedy named', async () => {
  const staged = await stageRuntime()
  try {
    const backend = createFirecrackerBackend({ privilegeProbe: { getgid: () => 1_000, getuid: () => 1_000 } })
    await assert.rejects(
      backend.start(staged.input(randomBytes(32).toString('base64url'))),
      /jailer must run as root/,
    )
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a missing jailer beside the firecracker binary is named rather than guessed at', async () => {
  const staged = await stageRuntime()
  try {
    await rm(join(staged.root, 'resources', 'jailer'))
    const backend = createFirecrackerBackend({ privilegeProbe: ROOT_PROBE })
    await assert.rejects(
      backend.start(staged.input(randomBytes(32).toString('base64url'))),
      /jailer must be installed beside the firecracker binary/,
    )
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})
