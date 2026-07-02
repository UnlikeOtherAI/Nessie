import assert from 'node:assert/strict'
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertInsideSandbox,
  extractSandboxConfig,
  SandboxViolationError,
} from './sandbox.js'
import { createSymlinkOrSkip } from './test-symlink.js'

const firstAllowedRoot = (
  config: Awaited<ReturnType<typeof extractSandboxConfig>>,
) => {
  const [root] = config.allowedRoots
  assert.ok(root)
  return root
}

const setupDir = async (): Promise<{
  root: string
  cleanup: () => Promise<void>
}> => {
  const created = await mkdtemp(join(tmpdir(), 'nessie-sandbox-'))
  const root = await realpath(created)
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

// ── Legacy string-array backward compatibility ─────────────────────────────

test('extractSandboxConfig accepts legacy string[] and normalizes defaults', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig({ allowedRoots: [root] }, 'test')
    assert.equal(config.allowedRoots.length, 1)
    const allowedRoot = firstAllowedRoot(config)
    assert.equal(allowedRoot.path, root)
    assert.equal(allowedRoot.kind, 'dir')
    assert.equal(allowedRoot.access, 'rw')
  } finally {
    await cleanup()
  }
})

// ── Object format parsing ─────────────────────────────────────────────────

test('extractSandboxConfig parses object entries with explicit kind and access', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, kind: 'dir', access: 'ro' }] },
      'test',
    )
    const allowedRoot = firstAllowedRoot(config)
    assert.equal(allowedRoot.kind, 'dir')
    assert.equal(allowedRoot.access, 'ro')
  } finally {
    await cleanup()
  }
})

test('extractSandboxConfig defaults missing kind to dir and access to rw', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root }] },
      'test',
    )
    const allowedRoot = firstAllowedRoot(config)
    assert.equal(allowedRoot.kind, 'dir')
    assert.equal(allowedRoot.access, 'rw')
  } finally {
    await cleanup()
  }
})

test('extractSandboxConfig rejects non-existent object path', async () => {
  await assert.rejects(
    extractSandboxConfig(
      { allowedRoots: [{ path: '/tmp/does-not-exist-12345' }] },
      'test',
    ),
    SandboxViolationError,
  )
})

test('extractSandboxConfig rejects object without path string', async () => {
  await assert.rejects(
    extractSandboxConfig({ allowedRoots: [{}] }, 'test'),
    SandboxViolationError,
  )
})

test('extractSandboxConfig rejects invalid object kind', async () => {
  const { root, cleanup } = await setupDir()
  try {
    await assert.rejects(
      extractSandboxConfig(
        { allowedRoots: [{ path: root, kind: 'directory' }] },
        'test',
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('extractSandboxConfig rejects invalid object access', async () => {
  const { root, cleanup } = await setupDir()
  try {
    await assert.rejects(
      extractSandboxConfig(
        { allowedRoots: [{ path: root, access: 'read' }] },
        'test',
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('extractSandboxConfig rejects mixed invalid entry', async () => {
  await assert.rejects(
    extractSandboxConfig({ allowedRoots: [42] }, 'test'),
    SandboxViolationError,
  )
})

// ── File kind validation ───────────────────────────────────────────────────

test('extractSandboxConfig validates file kind against actual filesystem type', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const filePath = join(root, 'config.json')
    await writeFile(filePath, '{}', 'utf8')

    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: filePath, kind: 'file', access: 'ro' }] },
      'test',
    )
    const allowedRoot = firstAllowedRoot(config)
    assert.equal(allowedRoot.kind, 'file')
    assert.equal(allowedRoot.access, 'ro')
  } finally {
    await cleanup()
  }
})

test('extractSandboxConfig rejects file kind when path is a directory', async () => {
  const { root, cleanup } = await setupDir()
  try {
    await assert.rejects(
      extractSandboxConfig(
        { allowedRoots: [{ path: root, kind: 'file' }] },
        'test',
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

// ── Access mode enforcement ──────────────────────────────────────────────────

test('assertInsideSandbox allows read on ro root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'ro' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      join(root, 'a.txt'),
      config,
      'test',
      'read',
    )
    assert.ok(resolved.startsWith(root))
  } finally {
    await cleanup()
  }
})

test('assertInsideSandbox rejects write on ro root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'ro' }] },
      'test',
    )
    await assert.rejects(
      assertInsideSandbox(join(root, 'a.txt'), config, 'test', 'write'),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

test('assertInsideSandbox allows write on rw root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'rw' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      join(root, 'a.txt'),
      config,
      'test',
      'write',
    )
    assert.ok(resolved.startsWith(root))
  } finally {
    await cleanup()
  }
})

test('assertInsideSandbox allows read on rw root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'rw' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      join(root, 'a.txt'),
      config,
      'test',
      'read',
    )
    assert.ok(resolved.startsWith(root))
  } finally {
    await cleanup()
  }
})

// ── File kind enforcement ──────────────────────────────────────────────────

test('assertInsideSandbox allows exact path match for file root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const filePath = join(root, 'config.json')
    await writeFile(filePath, '{}', 'utf8')

    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: filePath, kind: 'file', access: 'ro' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      filePath,
      config,
      'test',
      'read',
    )
    assert.equal(resolved, filePath)
  } finally {
    await cleanup()
  }
})

test('assertInsideSandbox rejects sub-path for file root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const filePath = join(root, 'config.json')
    await writeFile(filePath, '{}', 'utf8')

    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: filePath, kind: 'file', access: 'ro' }] },
      'test',
    )
    await assert.rejects(
      assertInsideSandbox(
        join(root, 'config.json.backup'),
        config,
        'test',
        'read',
      ),
      SandboxViolationError,
    )
  } finally {
    await cleanup()
  }
})

// ── Symlink escape still blocked ────────────────────────────────────────────

test('assertInsideSandbox rejects symlink escape regardless of access mode', async (t) => {
  const { root, cleanup } = await setupDir()
  const escapeTarget = await mkdtemp(join(tmpdir(), 'nessie-sandbox-out-'))
  try {
    const secret = join(escapeTarget, 'secret.txt')
    await writeFile(secret, 'leak', 'utf8')

    const linkPath = join(root, 'link.txt')
    const linked = await createSymlinkOrSkip(t, secret, linkPath, 'file')
    if (!linked) {
      return
    }

    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'rw' }] },
      'test',
    )
    await assert.rejects(
      assertInsideSandbox(linkPath, config, 'test', 'read'),
      SandboxViolationError,
    )
  } finally {
    await rm(escapeTarget, { recursive: true, force: true })
    await cleanup()
  }
})

// ── Multiple roots with different modes ────────────────────────────────────

test('assertInsideSandbox picks correct root for mixed modes', async () => {
  const { root: rwRoot, cleanup: cleanupRw } = await setupDir()
  const { root: roRoot, cleanup: cleanupRo } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      {
        allowedRoots: [
          { path: rwRoot, access: 'rw' },
          { path: roRoot, access: 'ro' },
        ],
      },
      'test',
    )

    // Write allowed in rw root
    const w = await assertInsideSandbox(
      join(rwRoot, 'w.txt'),
      config,
      'test',
      'write',
    )
    assert.ok(w.startsWith(rwRoot))

    // Write rejected in ro root
    await assert.rejects(
      assertInsideSandbox(join(roRoot, 'w.txt'), config, 'test', 'write'),
      SandboxViolationError,
    )

    // Read allowed in both
    const r1 = await assertInsideSandbox(
      join(rwRoot, 'r.txt'),
      config,
      'test',
      'read',
    )
    assert.ok(r1.startsWith(rwRoot))
    const r2 = await assertInsideSandbox(
      join(roRoot, 'r.txt'),
      config,
      'test',
      'read',
    )
    assert.ok(r2.startsWith(roRoot))
  } finally {
    await cleanupRw()
    await cleanupRo()
  }
})

// ── Empty/missing allowedRoots still rejected ──────────────────────────────

test('extractSandboxConfig rejects empty array', async () => {
  await assert.rejects(
    extractSandboxConfig({ allowedRoots: [] }, 'test'),
    SandboxViolationError,
  )
})

test('extractSandboxConfig rejects missing transportConfig', async () => {
  await assert.rejects(
    extractSandboxConfig(undefined, 'test'),
    SandboxViolationError,
  )
})

// ── Glob operation type ─────────────────────────────────────────────────────

test('assertInsideSandbox allows glob on ro root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'ro' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      join(root, 'sub'),
      config,
      'test',
      'glob',
    )
    assert.ok(resolved.startsWith(root))
  } finally {
    await cleanup()
  }
})

test('assertInsideSandbox allows glob on rw root', async () => {
  const { root, cleanup } = await setupDir()
  try {
    const config = await extractSandboxConfig(
      { allowedRoots: [{ path: root, access: 'rw' }] },
      'test',
    )
    const resolved = await assertInsideSandbox(
      join(root, 'sub'),
      config,
      'test',
      'glob',
    )
    assert.ok(resolved.startsWith(root))
  } finally {
    await cleanup()
  }
})
