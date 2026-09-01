// The packaged executor runtime: the layout both supervisors verify before
// they run anything. `desktop/src-tauri/src/executor_companion/runtime.rs` and
// `executor/src/runtime-integrity.ts` read exactly this file set and this
// manifest shape, so this module is their single producer — the desktop bundle
// and the Linux `nessie-executor` package are two callers of one preparation,
// never two implementations of it.
//
// The layout is host-shaped in two ways only, and the manifest states both so
// no reader has to guess from its own platform: Windows runs `node.exe` and
// installs `LICENSE` beside it, while POSIX runs `node` and keeps the licence
// one directory up.
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { build } from 'esbuild'

/** The files present in every package, whatever the host. */
export const EXECUTOR_RUNTIME_FIXED_FILES = ['nessie-executor.cjs', 'manifest.json', 'NODE_LICENSE']

/** The only two names the packaged Node binary may have. */
export const EXECUTOR_NODE_EXECUTABLES = ['node', 'node.exe']

/** The only two names the packaged native helper may have. */
export const EXECUTOR_NATIVE_HELPERS = ['nessie-executor-native', 'nessie-executor-native.exe']

/**
 * The only manifest format both supervisors accept. `nodeExecutable` was added
 * without a format bump on purpose: a reader that ignores an unknown key still
 * verifies everything format 1 ever promised, and both readers resolve the Node
 * file name from the manifest rather than from their own platform.
 */
export const EXECUTOR_RUNTIME_MANIFEST_FORMAT = 1

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/** Windows installs `LICENSE` beside `node.exe`; POSIX keeps it one level up. */
export const nodeLicensePath = (nodeExecutablePath, platform) => (
  platform === 'win32'
    ? resolve(dirname(nodeExecutablePath), 'LICENSE')
    : resolve(dirname(nodeExecutablePath), '..', 'LICENSE')
)

export const nodeExecutableName = (platform) => (platform === 'win32' ? 'node.exe' : 'node')

const nativeHelperName = (platform) => (
  platform === 'win32' ? 'nessie-executor-native.exe' : 'nessie-executor-native'
)

const requireNodeLicense = async (path, nodeExecutablePath) => {
  try {
    await readFile(path)
  } catch {
    throw new Error(`Unable to locate the Node.js license beside ${nodeExecutablePath}.`)
  }
}

/**
 * Bundles the executor CLI, copies the build host's Node beside it with its
 * licence, optionally copies the native helper, and writes the sha256 manifest.
 * The copied Node is the runtime the package ships, so every build host must run
 * the Node version the bundle targets (22).
 *
 * `platform` and `nodeExecutablePath` are injectable so both layouts are
 * exercised from one host; every caller in the repository takes the defaults.
 */
export const prepareExecutorRuntime = async ({
  entryPoint,
  nativeHelperPath,
  nodeExecutablePath = process.execPath,
  outputDirectory,
  platform = process.platform,
}) => {
  const runtimeDirectory = resolve(outputDirectory)
  const executorBundlePath = resolve(runtimeDirectory, 'nessie-executor.cjs')
  const nodeExecutable = nodeExecutableName(platform)
  const nodePath = resolve(runtimeDirectory, nodeExecutable)
  const licenseSourcePath = nodeLicensePath(nodeExecutablePath, platform)
  const isPosix = platform !== 'win32'

  await requireNodeLicense(licenseSourcePath, nodeExecutablePath)
  await rm(runtimeDirectory, { force: true, recursive: true })
  await mkdir(runtimeDirectory, { recursive: true })

  await build({
    bundle: true,
    entryPoints: [resolve(entryPoint)],
    format: 'cjs',
    outfile: executorBundlePath,
    platform: 'node',
    target: 'node22',
  })
  await copyFile(nodeExecutablePath, nodePath)
  if (isPosix) await chmod(nodePath, 0o755)
  await copyFile(licenseSourcePath, resolve(runtimeDirectory, 'NODE_LICENSE'))

  // The helper establishes and proves the Windows state DACL, so a package that
  // ships one pins its bytes in the same manifest as the runtime: an unverified
  // helper would decide privacy for state it could also be swapped to expose.
  let nativeHelper
  if (nativeHelperPath !== undefined) {
    nativeHelper = nativeHelperName(platform)
    const helperTargetPath = resolve(runtimeDirectory, nativeHelper)
    await copyFile(resolve(nativeHelperPath), helperTargetPath)
    if (isPosix) await chmod(helperTargetPath, 0o755)
  }

  const manifest = {
    executorBundleSha256: await digest(executorBundlePath),
    format: EXECUTOR_RUNTIME_MANIFEST_FORMAT,
    ...(nativeHelper === undefined
      ? {}
      : {
        nativeHelper,
        nativeHelperSha256: await digest(resolve(runtimeDirectory, nativeHelper)),
      }),
    nodeExecutable,
    nodeSha256: await digest(nodePath),
    nodeVersion: process.versions.node,
  }
  const manifestPath = resolve(runtimeDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

  return { executorBundlePath, manifest, manifestPath, nodePath, runtimeDirectory }
}
