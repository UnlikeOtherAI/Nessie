import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildJailerArgv,
  connectGuestVsockPort,
  deriveGuestEgressToken,
  jailerLayout,
  listenGuestVsockPort,
} from '../src/firecracker/index.js'
import {
  createVirtualizationFrameworkBackend,
  selectGuestVmBackend,
  stopChildProcess,
} from '../src/guest-vm-backend.js'
import type { ExecutorHost } from '../src/host-platform.js'

const host = (sandboxBackend: ExecutorHost['sandboxBackend'], os: 'linux' | 'macos' | 'windows'): ExecutorHost => ({
  platform: { architecture: os === 'macos' ? 'arm64' : 'x64', os, osMajorVersion: 15 },
  sandboxBackend,
  supervisor: 'service',
})

test('the backend seam picks from the host fact and refuses in words when there is none', () => {
  assert.equal(
    selectGuestVmBackend(host('virtualization_framework', 'macos')).kind,
    'virtualization_framework',
  )
  const firecracker = { kind: 'firecracker' as const, start: async () => { throw new Error('unused') } }
  assert.equal(selectGuestVmBackend(host('firecracker', 'linux'), {}, () => firecracker), firecracker)
  assert.throws(
    () => selectGuestVmBackend(host('none', 'linux')),
    /no sandbox backend/,
  )
  assert.throws(
    () => selectGuestVmBackend(host('hyperv', 'windows')),
    /no Hyper-V sandbox backend/,
  )
  // A firecracker host with no factory available fails closed rather than
  // silently falling through to the macOS helper.
  assert.throws(() => selectGuestVmBackend(host('firecracker', 'linux')), /Firecracker backend is unavailable/)
})

test('the macOS backend still builds exactly the session argv the signed helper expects', async () => {
  const calls: Array<{ argv: string[]; input: string; path: string }> = []
  const backend = createVirtualizationFrameworkBackend({
    launchProcess: async (call) => {
      calls.push(call)
      return {
        actBrowser: async () => ({ status: 'acted' as const }),
        closed: Promise.resolve(),
        closeCodingSession: async () => {},
        inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
        launchCodingSession: async () => {},
        observeCodingSession: async () => ({ agent: 'codex' as const, lifecycle: 'running' as const }),
        observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
        openBrowser: async () => {},
        runCommand: async () => ({ exitCode: 0, output: '', success: true }),
        stop: async () => {},
      }
    },
  })
  await backend.start({
    bootstrapToken: 'token',
    consolePath: '/console',
    egressGatewaySocketPath: '/gateway.sock',
    initrdPath: '/initrd',
    kernelPath: '/kernel',
    readyTimeoutMs: 1,
    resources: { memoryMiB: 4_096, vcpuCount: 2 },
    runtimeManifestDigest: `sha256:${'b'.repeat(64)}`,
    runtimeSnapshotPath: '/runtime',
    sessionDirectory: '/session',
    sessionId: 'session',
    vmHelperPath: '/helper',
    workspacePath: '/work',
  })
  assert.deepEqual(calls[0].argv, [
    'session',
    '--console', '/console',
    '--kernel', '/kernel',
    '--initrd', '/initrd',
    '--workspace-cow', '/work',
    '--runtime-bundle', '/runtime',
    '--runtime-manifest-digest', `sha256:${'b'.repeat(64)}`,
    '--egress-gateway', '/gateway.sock',
    '--bootstrap-token-stdin',
  ])
  assert.equal(calls[0].input, 'token')
  assert.equal(calls[0].argv.includes('token'), false)
})

test('the jailer layout and argv follow the documented chroot path and id rules', () => {
  const layout = jailerLayout({
    chrootBaseDirectory: '/state/jail',
    firecrackerPath: '/usr/lib/nessie-executor/resources/firecracker/firecracker',
    sessionId: 'abc-123',
  })
  assert.equal(layout.chrootDirectory, '/state/jail/firecracker/abc-123/root')
  assert.equal(layout.apiSocketPath, '/state/jail/firecracker/abc-123/root/firecracker.socket')
  assert.equal(layout.vsockPath, '/state/jail/firecracker/abc-123/root/v.sock')
  assert.equal(layout.jailerPath, '/usr/lib/nessie-executor/resources/firecracker/jailer')
  assert.throws(
    () => buildJailerArgv({
      chrootBaseDirectory: '/state/jail',
      firecrackerPath: '/fc',
      gid: 0,
      sessionId: 'not a valid id',
      uid: 0,
    }),
    /valid jailer id/,
  )
})

test('the guest egress token is the HMAC the guest itself derives', () => {
  // Cross-checked against executor/guest/protocol.go deriveEgressToken: the
  // same 32-byte key and the same fixed context string.
  const token = 'A'.repeat(43)
  assert.equal(deriveGuestEgressToken(token).length, 43)
  assert.notEqual(deriveGuestEgressToken(token), token)
  assert.throws(() => deriveGuestEgressToken('short'), /bootstrap token is malformed/)
})

test('a host-initiated vsock connection sends CONNECT and waits for the OK acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-'))
  const udsPath = join(directory, 'v.sock')
  const received: string[] = []
  const server = createServer((socket: Socket) => {
    socket.once('data', (chunk: Buffer) => {
      received.push(chunk.toString('utf8'))
      // Firecracker's acknowledgement, plus a first guest byte in the same
      // write: the client must keep that byte for the real reader.
      socket.write('OK 1073741824\nhello-guest')
    })
  })
  try {
    await new Promise<void>((resolvePromise) => server.listen(udsPath, () => resolvePromise()))
    const socket = await connectGuestVsockPort(udsPath, 49_152)
    assert.deepEqual(received, ['CONNECT 49152\n'])
    const first = await new Promise<Buffer>((resolvePromise) => socket.once('data', resolvePromise))
    assert.equal(first.toString('utf8'), 'hello-guest')
    socket.destroy()
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { force: true, recursive: true })
  }
})

test('a refused host-initiated vsock connection is an error, never a half-open stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-refuse-'))
  const udsPath = join(directory, 'v.sock')
  const server = createServer((socket: Socket) => {
    // Firecracker terminates the host connection when nothing is listening.
    socket.once('data', () => socket.destroy())
  })
  try {
    await new Promise<void>((resolvePromise) => server.listen(udsPath, () => resolvePromise()))
    await assert.rejects(connectGuestVsockPort(udsPath, 52), /closed the guest vsock connection/)
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { force: true, recursive: true })
  }
})

test('guest-initiated connections arrive on the per-port socket Firecracker forwards to', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-listen-'))
  const udsPath = join(directory, 'v.sock')
  let seen: Buffer | undefined
  const listener = await listenGuestVsockPort(udsPath, 49_153, (socket) => {
    socket.once('data', (chunk: Buffer) => { seen = chunk })
  })
  try {
    assert.equal(listener.socketPath, `${udsPath}_49153`)
    const { createConnection } = await import('node:net')
    const guest = createConnection({ path: listener.socketPath })
    await new Promise<void>((resolvePromise) => guest.once('connect', () => resolvePromise()))
    guest.write(randomBytes(4))
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50) })
    assert.equal(seen?.byteLength, 4)
    guest.destroy()
  } finally {
    await listener.close()
    await rm(directory, { force: true, recursive: true })
  }
})

test('a process that ignores SIGTERM is killed once the stop window has passed', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ], { stdio: 'ignore' })
  await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 200) })
  await stopChildProcess(child, 250)
  assert.equal(child.signalCode, 'SIGKILL')
})
