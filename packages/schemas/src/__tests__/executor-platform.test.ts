import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorProfileSchema,
  ImplementedExecutorOperationKeySchema,
} from '../executor.js'
import {
  EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS,
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  EXECUTOR_WORKSPACE_ONLY_PROFILES,
  ExecutorPlatformFactsSchema,
  ExecutorPlatformSchema,
  ExecutorSandboxBackendSchema,
  ExecutorSupervisorSchema,
} from '../executor-platform.js'

const accepted: Array<[string, unknown]> = [
  ['macOS 15 on Apple Silicon', { architecture: 'arm64', os: 'macos', osMajorVersion: 15 }],
  ['macOS 26 on Apple Silicon', { architecture: 'arm64', os: 'macos', osMajorVersion: 26 }],
  ['Linux kernel 5 on x86_64', { architecture: 'x64', os: 'linux', osMajorVersion: 5 }],
  ['Linux kernel 6 on arm64', { architecture: 'arm64', os: 'linux', osMajorVersion: 6 }],
  ['Windows 10 22H2', { architecture: 'x64', os: 'windows', osMajorVersion: 19045 }],
  ['Windows 11 23H2', { architecture: 'x64', os: 'windows', osMajorVersion: 22631 }],
]

const rejected: Array<[string, unknown]> = [
  ['macOS 14', { architecture: 'arm64', os: 'macos', osMajorVersion: 14 }],
  ['Linux kernel 4', { architecture: 'x64', os: 'linux', osMajorVersion: 4 }],
  ['Windows 10 21H2', { architecture: 'x64', os: 'windows', osMajorVersion: 19044 }],
  ['an unknown operating system', { architecture: 'x64', os: 'freebsd', osMajorVersion: 14 }],
  ['an unknown architecture', { architecture: 'riscv64', os: 'linux', osMajorVersion: 6 }],
  ['a fractional version', { architecture: 'x64', os: 'linux', osMajorVersion: 6.1 }],
  [
    'an unknown extra fact',
    { architecture: 'x64', os: 'linux', osMajorVersion: 6, virtualized: true },
  ],
]

test('the platform contract accepts every supported host', () => {
  for (const [name, platform] of accepted) {
    assert.equal(ExecutorPlatformSchema.safeParse(platform).success, true, name)
  }
})

test('the platform contract refuses unknown hosts and below-minimum versions', () => {
  for (const [name, platform] of rejected) {
    assert.equal(ExecutorPlatformSchema.safeParse(platform).success, false, name)
  }
})

test('a below-minimum version names the requirement rather than failing generically', () => {
  const parsed = ExecutorPlatformSchema.safeParse({
    architecture: 'x64',
    os: 'windows',
    osMajorVersion: 19044,
  })
  assert.equal(parsed.success, false)
  assert.match(
    parsed.success ? '' : parsed.error.issues[0]?.message ?? '',
    /macOS 15\+, Linux kernel 5\+, or Windows build 19045\+/,
  )
})

test('every operating system declares one minimum version', () => {
  assert.deepEqual(
    Object.keys(EXECUTOR_MINIMUM_OS_MAJOR_VERSIONS).sort(),
    ['linux', 'macos', 'windows'],
  )
})

test('supervisors and sandbox backends are closed sets', () => {
  for (const supervisor of ['desktop', 'service']) {
    assert.equal(ExecutorSupervisorSchema.safeParse(supervisor).success, true)
  }
  assert.equal(ExecutorSupervisorSchema.safeParse('systemd').success, false)
  for (const backend of ['virtualization_framework', 'firecracker', 'hyperv', 'none']) {
    assert.equal(ExecutorSandboxBackendSchema.safeParse(backend).success, true)
  }
  assert.equal(ExecutorSandboxBackendSchema.safeParse('qemu').success, false)
})

test('stored platform facts are all three host facts or nothing', () => {
  const facts = {
    platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    sandboxBackend: 'firecracker',
    supervisor: 'service',
  }
  assert.equal(ExecutorPlatformFactsSchema.safeParse(facts).success, true)
  // The shape a pre-widening executor row holds: platform facts only, and no
  // supervisor. It must not read as a valid record.
  assert.equal(
    ExecutorPlatformFactsSchema.safeParse(
      { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    ).success,
    false,
  )
  assert.equal(ExecutorPlatformFactsSchema.safeParse({}).success, false)
})

test('the workspace-only bundle names implemented operations and one profile', () => {
  for (const operationKey of EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS) {
    assert.equal(
      ImplementedExecutorOperationKeySchema.safeParse(operationKey).success,
      true,
      operationKey,
    )
  }
  for (const profile of EXECUTOR_WORKSPACE_ONLY_PROFILES) {
    assert.equal(ExecutorProfileSchema.safeParse(profile).success, true, profile)
  }
})
