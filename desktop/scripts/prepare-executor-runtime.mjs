import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const repositoryDirectory = resolve(desktopDirectory, '..')
const runtimeDirectory = resolve(desktopDirectory, 'src-tauri/resources/executor-runtime')
const executorBundlePath = resolve(runtimeDirectory, 'nessie-executor.cjs')
const nodePath = resolve(runtimeDirectory, 'node')
const nodeLicensePath = resolve(dirname(process.execPath), '..', 'LICENSE')

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

const requireNodeLicense = async () => {
  try {
    await readFile(nodeLicensePath)
  } catch {
    throw new Error(`Unable to locate the Node.js license beside ${process.execPath}.`)
  }
}

await requireNodeLicense()
await rm(runtimeDirectory, { force: true, recursive: true })
await mkdir(runtimeDirectory, { recursive: true })

await build({
  bundle: true,
  entryPoints: [resolve(repositoryDirectory, 'executor/src/index.ts')],
  format: 'cjs',
  outfile: executorBundlePath,
  platform: 'node',
  target: 'node22',
})
await copyFile(process.execPath, nodePath)
await chmod(nodePath, 0o755)
await copyFile(nodeLicensePath, resolve(runtimeDirectory, 'NODE_LICENSE'))
await writeFile(
  resolve(runtimeDirectory, 'manifest.json'),
  `${JSON.stringify({
    executorBundleSha256: await digest(executorBundlePath),
    format: 1,
    nodeSha256: await digest(nodePath),
    nodeVersion: process.versions.node,
  }, null, 2)}\n`,
  { mode: 0o644 },
)
