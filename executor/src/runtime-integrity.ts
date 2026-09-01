import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * Release integrity for the packaged executor runtime.
 *
 * macOS binds executor controls to `codesign` and a pinned Developer ID team.
 * Linux has no in-process equivalent, so the trust root is the one the OS
 * already holds: a `.deb` installed from Nessie's signed apt repository lays
 * the runtime down root-owned under `/usr/lib`, and only an administrator can
 * produce that state. A hash manifest alone is a self-attestation — whoever
 * can rewrite the binary can rewrite the manifest beside it — so ownership and
 * mode bits are checked with it, never instead of it.
 *
 * The decision is a pure function over facts so every branch is testable; uid 0
 * cannot be produced in a temporary directory by an ordinary test.
 */

export const EXECUTOR_RUNTIME_FILES = [
  'node',
  'nessie-executor.cjs',
  'manifest.json',
  'NODE_LICENSE',
] as const

export type ExecutorRuntimeFileName = typeof EXECUTOR_RUNTIME_FILES[number]

/** The two files whose bytes the manifest pins. */
export const EXECUTOR_RUNTIME_HASHED_FILES = ['node', 'nessie-executor.cjs'] as const

export type ExecutorRuntimeHashedFileName = typeof EXECUTOR_RUNTIME_HASHED_FILES[number]

/** The root-controlled prefixes a packaged runtime may live under. */
const ROOT_CONTROLLED_PREFIXES = ['/usr/lib/', '/usr/share/']

const MODE_MASK_GROUP_OR_OTHER_WRITE = 0o022

const ROOT_UID = 0

export type ExecutorRuntimeEntryFacts = {
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
  mode: number
  uid: number
}

export type ExecutorRuntimeFacts = {
  /** Streamed sha256 of each hashed file, absent when the file is unreadable. */
  digests: Partial<Record<ExecutorRuntimeHashedFileName, string>>
  /** Absent when the runtime directory does not exist. */
  directory?: ExecutorRuntimeEntryFacts
  /** Resolved directory path; the ownership rules are decided against this. */
  directoryRealPath: string
  files: Partial<Record<ExecutorRuntimeFileName, ExecutorRuntimeEntryFacts>>
  /** Raw manifest bytes as text, absent when the manifest is unreadable. */
  manifestText?: string
  platform: NodeJS.Platform
  /** Resolved path of the bundle this process is executing, when known. */
  runningBundleRealPath?: string
}

export type ExecutorRuntimeVerdict = { ok: true } | { ok: false; reason: string }

const refuse = (reason: string): ExecutorRuntimeVerdict => ({ ok: false, reason })

const hexDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

const verifyManifest = (
  manifestText: string,
  digests: ExecutorRuntimeFacts['digests'],
): ExecutorRuntimeVerdict => {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    return refuse('the packaged runtime manifest is malformed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('the packaged runtime manifest is malformed')
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.format !== 1) return refuse('the packaged runtime manifest declares an unsupported format')
  if (typeof manifest.nodeVersion !== 'string' || !manifest.nodeVersion) {
    return refuse('the packaged runtime manifest names no Node version')
  }
  if (!hexDigest(manifest.nodeSha256) || !hexDigest(manifest.executorBundleSha256)) {
    return refuse('the packaged runtime manifest is malformed')
  }
  if (manifest.nodeSha256 !== digests.node) {
    return refuse('the packaged Node binary does not match the runtime manifest')
  }
  if (manifest.executorBundleSha256 !== digests['nessie-executor.cjs']) {
    return refuse('the packaged executor bundle does not match the runtime manifest')
  }
  return { ok: true }
}

const verifyOwnership = (name: string, entry: ExecutorRuntimeEntryFacts): ExecutorRuntimeVerdict => {
  if (entry.uid !== ROOT_UID) return refuse(`${name} is not owned by root`)
  if ((entry.mode & MODE_MASK_GROUP_OR_OTHER_WRITE) !== 0) {
    return refuse(`${name} is writable by users other than root`)
  }
  return { ok: true }
}

/**
 * The whole decision, over facts only. Ownership and location are Linux rules:
 * other hosts keep their own OS-held trust root (macOS `codesign`).
 */
export const verifyExecutorRuntime = (facts: ExecutorRuntimeFacts): ExecutorRuntimeVerdict => {
  const { directory } = facts
  if (!directory) return refuse('the packaged runtime directory is missing')
  if (directory.isSymbolicLink || !directory.isDirectory) {
    return refuse('the packaged runtime is not an ordinary directory')
  }
  for (const name of EXECUTOR_RUNTIME_FILES) {
    const entry = facts.files[name]
    if (!entry) return refuse(`${name} is missing from the packaged runtime`)
    if (entry.isSymbolicLink || !entry.isFile) return refuse(`${name} is not an ordinary file`)
  }
  if (facts.manifestText === undefined) return refuse('the packaged runtime manifest is unreadable')
  const manifest = verifyManifest(facts.manifestText, facts.digests)
  if (!manifest.ok) return manifest
  if (
    facts.runningBundleRealPath !== undefined
    && facts.runningBundleRealPath !== join(facts.directoryRealPath, 'nessie-executor.cjs')
  ) {
    return refuse('the running executor bundle is not the packaged one')
  }
  if (facts.platform !== 'linux') return { ok: true }
  const directoryOwnership = verifyOwnership('the packaged runtime directory', directory)
  if (!directoryOwnership.ok) return directoryOwnership
  for (const name of EXECUTOR_RUNTIME_FILES) {
    const ownership = verifyOwnership(name, facts.files[name]!)
    if (!ownership.ok) return ownership
  }
  if (!ROOT_CONTROLLED_PREFIXES.some((prefix) => facts.directoryRealPath.startsWith(prefix))) {
    return refuse('the packaged runtime is not installed under /usr/lib or /usr/share')
  }
  return { ok: true }
}

const entryFacts = async (path: string): Promise<ExecutorRuntimeEntryFacts | undefined> => {
  try {
    const metadata = await lstat(path)
    return {
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymbolicLink: metadata.isSymbolicLink(),
      mode: metadata.mode,
      uid: metadata.uid,
    }
  } catch {
    return undefined
  }
}

/** Streamed so verifying a ~100 MB Node binary never buffers it whole. */
const streamedDigest = async (path: string): Promise<string | undefined> => {
  const hash = createHash('sha256')
  try {
    await pipeline(createReadStream(path), hash)
  } catch {
    return undefined
  }
  return hash.digest('hex')
}

const resolvedPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

export type ExecutorRuntimeFactOptions = { runningBundlePath?: string }

/** The thin filesystem adapter behind {@link verifyExecutorRuntime}. */
export const collectExecutorRuntimeFacts = async (
  runtimeDirectory: string,
  options: ExecutorRuntimeFactOptions = {},
): Promise<ExecutorRuntimeFacts> => {
  const root = resolve(runtimeDirectory)
  const files: ExecutorRuntimeFacts['files'] = {}
  for (const name of EXECUTOR_RUNTIME_FILES) {
    const facts = await entryFacts(join(root, name))
    if (facts) files[name] = facts
  }
  const digests: ExecutorRuntimeFacts['digests'] = {}
  for (const name of EXECUTOR_RUNTIME_HASHED_FILES) {
    const digest = await streamedDigest(join(root, name))
    if (digest !== undefined) digests[name] = digest
  }
  let manifestText: string | undefined
  try {
    manifestText = await readFile(join(root, 'manifest.json'), 'utf8')
  } catch {
    manifestText = undefined
  }
  const directory = await entryFacts(root)
  return {
    digests,
    ...(directory ? { directory } : {}),
    directoryRealPath: await resolvedPath(root),
    files,
    ...(manifestText === undefined ? {} : { manifestText }),
    platform: process.platform,
    ...(options.runningBundlePath === undefined
      ? {}
      : { runningBundleRealPath: await resolvedPath(options.runningBundlePath) }),
  }
}

/**
 * The packaged launcher execs the packaged Node beside the packaged bundle
 * (`/usr/bin/nessie-executor` is a two-line `exec`), and the desktop shell
 * spawns the same pair out of its resource directory. The runtime directory is
 * therefore the directory of the Node binary running this process, and the
 * bundle check below proves the code being executed came from it.
 */
export const packagedRuntimeDirectory = (): string => dirname(process.execPath)

/**
 * The gate is armed only for a packaged CLI whose runtime sits under
 * `/usr/lib` — a root-controlled location. A development run (tsx, a hand-built
 * bundle, an AppImage, a checkout in a home directory) never satisfies both, so
 * this changes nothing outside an installed package, and the macOS desktop keeps
 * `codesign` as its trust root.
 */
export const packagedRuntimeGateApplies = async (): Promise<boolean> => {
  if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return false
  const directory = await resolvedPath(packagedRuntimeDirectory())
  return ROOT_CONTROLLED_PREFIXES.some((prefix) => directory.startsWith(prefix))
}

/**
 * Refuses to continue when a packaged runtime fails verification. The message
 * names the remedy, because an altered or user-writable runtime is not a
 * transient error: the package has to come back from the signed repository.
 */
export const assertPackagedExecutorRuntime = async (): Promise<void> => {
  if (!await packagedRuntimeGateApplies()) return
  const runtimeDirectory = packagedRuntimeDirectory()
  const bundlePath = process.argv[1]
  const facts = await collectExecutorRuntimeFacts(runtimeDirectory, {
    ...(bundlePath ? { runningBundlePath: bundlePath } : {}),
  })
  const verdict = verifyExecutorRuntime(facts)
  if (verdict.ok) return
  throw new Error(
    `The Nessie Executor runtime failed verification: ${verdict.reason}. `
    + 'Reinstall the nessie-executor package from the Nessie apt repository; '
    + 'a runtime that is not root-owned is never trusted.',
  )
}
