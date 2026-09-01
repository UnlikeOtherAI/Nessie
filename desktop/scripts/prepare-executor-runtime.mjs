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
const nodeLicensePath = resolve(dirname(process.execPath), 'LICENSE')
const nodeLicenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

const nodeLicense = async () => {
  try {
    return await readFile(nodeLicensePath)
  } catch {
    const response = await fetch(nodeLicenseUrl)
    if (!response.ok) {
      throw new Error(`Unable to download the Node.js license for ${process.versions.node}.`)
    }
    const license = await response.text()
    if (!license.startsWith('Node.js is licensed for use as follows:')) {
      throw new Error(`Downloaded Node.js license for ${process.versions.node} was invalid.`)
    }
    return Buffer.from(license)
  }
}

const license = await nodeLicense()
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
await writeFile(resolve(runtimeDirectory, 'NODE_LICENSE'), license, { mode: 0o644 })
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
