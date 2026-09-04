import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LINUX_KVM_DEVICE,
  SUPERVISOR_ENVIRONMENT_VARIABLE,
  defaultHostPlatformProbe,
  detectExecutorHost,
  sandboxRemedyForHost,
  type HostPlatformProbe,
} from '../src/host-platform.js'

const probe = (overrides: Partial<HostPlatformProbe>): HostPlatformProbe => ({
  architecture: 'arm64',
  canReadWrite: () => false,
  environment: {},
  exists: () => false,
  kernelRelease: '24.6.0',
  platform: 'darwin',
  ...overrides,
})

test('macOS 15 on Apple Silicon keeps the Virtualization.framework backend', () => {
  const host = detectExecutorHost(probe({}))
  assert.deepEqual(host.platform, { architecture: 'arm64', os: 'macos', osMajorVersion: 15 })
  assert.equal(host.sandboxBackend, 'virtualization_framework')
  assert.equal(host.supervisor, 'service')
})

test('an Intel Mac and a pre-15 macOS are refused exactly as before', () => {
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'x64' })),
    /Set no execution capability/,
  )
  assert.throws(
    () => detectExecutorHost(probe({ kernelRelease: '23.6.0' })),
    /macOS 15\+ on Apple Silicon/,
  )
})

test('Linux reports its kernel major and finds Firecracker through /dev/kvm', () => {
  const paths: string[] = []
  const host = detectExecutorHost(probe({
    architecture: 'x64',
    canReadWrite: (path) => {
      paths.push(path)
      return true
    },
    kernelRelease: '6.14.0-27-generic',
    platform: 'linux',
  }))
  assert.deepEqual(host.platform, { architecture: 'x64', os: 'linux', osMajorVersion: 6 })
  assert.equal(host.sandboxBackend, 'firecracker')
  assert.deepEqual(paths, [LINUX_KVM_DEVICE])
})

test('a Linux host that cannot open /dev/kvm reports no sandbox backend', () => {
  const host = detectExecutorHost(probe({
    architecture: 'x64',
    kernelRelease: '6.14.0-27-generic',
    platform: 'linux',
  }))
  assert.equal(host.sandboxBackend, 'none')
  assert.match(sandboxRemedyForHost(host), /kvm` group/)
})

test('Linux runs on arm64 too, and refuses an unsupported architecture', () => {
  const host = detectExecutorHost(probe({
    canReadWrite: () => true,
    kernelRelease: '6.8.0',
    platform: 'linux',
  }))
  assert.equal(host.platform.architecture, 'arm64')
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'riscv64', kernelRelease: '6.8.0', platform: 'linux' })),
    /Set no execution capability/,
  )
})

test('a Linux kernel below the minimum is refused with the requirement named', () => {
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'x64', kernelRelease: '4.19.0', platform: 'linux' })),
    /below the minimum of 5/,
  )
})

test('Windows reads its build number and finds Hyper-V by its service binary', () => {
  const paths: string[] = []
  const host = detectExecutorHost(probe({
    architecture: 'x64',
    environment: { SystemRoot: 'D:\\Windows' },
    exists: (path) => {
      paths.push(path)
      return true
    },
    kernelRelease: '10.0.22631',
    platform: 'win32',
  }))
  assert.deepEqual(host.platform, { architecture: 'x64', os: 'windows', osMajorVersion: 22631 })
  assert.equal(host.sandboxBackend, 'hyperv')
  assert.deepEqual(paths, ['D:\\Windows\\System32\\vmms.exe'])
})

test('Windows without Hyper-V still pairs, and names enabling it as the remedy', () => {
  const host = detectExecutorHost(probe({
    architecture: 'x64',
    kernelRelease: '10.0.19045',
    platform: 'win32',
  }))
  assert.equal(host.platform.osMajorVersion, 19045)
  assert.equal(host.sandboxBackend, 'none')
  assert.match(sandboxRemedyForHost(host), /Hyper-V/)
})

test('a Windows build below 19045 and a non-x64 Windows are refused', () => {
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'x64', kernelRelease: '10.0.19044', platform: 'win32' })),
    /below the minimum of 19045/,
  )
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'arm64', kernelRelease: '10.0.22631', platform: 'win32' })),
    /Set no execution capability/,
  )
})

test('an unreadable version string and an unknown platform both fail closed', () => {
  assert.throws(
    () => detectExecutorHost(probe({ architecture: 'x64', kernelRelease: 'unknown', platform: 'linux' })),
    /unreadable version/,
  )
  assert.throws(() => detectExecutorHost(probe({ platform: 'aix' })), /Set no execution capability/)
})

test('the supervisor comes from the environment and never falls back silently', () => {
  const linux = (supervisor?: string): HostPlatformProbe => probe({
    architecture: 'x64',
    environment: supervisor === undefined ? {} : { [SUPERVISOR_ENVIRONMENT_VARIABLE]: supervisor },
    kernelRelease: '6.8.0',
    platform: 'linux',
  })
  assert.equal(detectExecutorHost(linux()).supervisor, 'service')
  assert.equal(detectExecutorHost(linux('service')).supervisor, 'service')
  assert.equal(detectExecutorHost(linux('desktop')).supervisor, 'desktop')
  assert.throws(() => detectExecutorHost(linux('systemd')), /NESSIE_EXECUTOR_SUPERVISOR/)
  assert.throws(() => detectExecutorHost(linux('')), /NESSIE_EXECUTOR_SUPERVISOR/)
})

test('the default probe reads this machine rather than a fixture', () => {
  const live = defaultHostPlatformProbe()
  assert.equal(live.platform, process.platform)
  assert.equal(live.architecture, process.arch)
  assert.equal(typeof live.kernelRelease, 'string')
  // A path that cannot exist proves the probe answers from the filesystem.
  assert.equal(live.exists('/nessie-executor-absent-probe-path'), false)
  assert.equal(live.canReadWrite('/nessie-executor-absent-probe-path'), false)
})
