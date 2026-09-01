// The packaged executor runtime: the layout both supervisors verify before
// they run anything. `desktop/src-tauri/src/executor_companion/runtime.rs` and
// `executor/src/runtime-integrity.ts` read exactly these four files and this
// manifest shape, so this module is their single producer — the desktop bundle
// and the Linux `nessie-executor` package are two callers of one preparation,
// never two implementations of it.
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { build } from 'esbuild'

/** The exact file set both supervisors require. */
export const EXECUTOR_RUNTIME_FILES = ['node', 'nessie-executor.cjs', 'manifest.json', 'NODE_LICENSE']

/** The only manifest format both supervisors accept. */
export const EXECUTOR_RUNTIME_MANIFEST_FORMAT = 1

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

const nodeLicensePath = () => resolve(dirname(process.execPath), '..', 'LICENSE')

const requireNodeLicense = async (path) => {
  try {
    await readFile(path)
  } catch {
    throw new Error(`Unable to locate the Node.js license beside ${process.execPath}.`)
  }
}

/**
 * Bundles the executor CLI, copies the build host's Node beside it with its
 * licence, and writes the sha256 manifest. The copied Node is the runtime the
 * package ships, so every build host must run the Node version the bundle
 * targets (22).
 */
export const prepareExecutorRuntime = async ({ entryPoint, outputDirectory }) => {
  const runtimeDirectory = resolve(outputDirectory)
  const executorBundlePath = resolve(runtimeDirectory, 'nessie-executor.cjs')
  const nodePath = resolve(runtimeDirectory, 'node')
  const licenseSourcePath = nodeLicensePath()

  await requireNodeLicense(licenseSourcePath)
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
  await copyFile(process.execPath, nodePath)
  await chmod(nodePath, 0o755)
  await copyFile(licenseSourcePath, resolve(runtimeDirectory, 'NODE_LICENSE'))

  const manifest = {
    executorBundleSha256: await digest(executorBundlePath),
    format: EXECUTOR_RUNTIME_MANIFEST_FORMAT,
    nodeSha256: await digest(nodePath),
    nodeVersion: process.versions.node,
  }
  const manifestPath = resolve(runtimeDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

  return { executorBundlePath, manifest, manifestPath, nodePath, runtimeDirectory }
}
