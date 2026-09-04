import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const desktopDirectory = resolve(scriptDirectory, '..')
const repositoryDirectory = resolve(desktopDirectory, '..')
const pnpmCliCandidates = [
  resolve(repositoryDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  resolve(process.env.APPDATA ?? '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
]
const embeddedBuildConfig = JSON.stringify({ build: { frontendDist: '../../admin/dist' } })
const productionApiUrl = 'https://api.nessie.works'

const pnpmCli = process.platform === 'win32'
  ? await (async () => {
    for (const candidate of pnpmCliCandidates) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Try the next configured PNPM location.
      }
    }
    throw new Error('PNPM was not found. Install PNPM before building the embedded desktop app.')
  })()
  : null

const run = (command, arguments_, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, arguments_, {
    cwd: desktopDirectory,
    stdio: 'inherit',
    ...options,
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolveRun()
      return
    }
    reject(new Error(`${command} ${arguments_.join(' ')} failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`))
  })
})

const runPnpm = (arguments_, options) => process.platform === 'win32'
  ? run(process.execPath, [pnpmCli, ...arguments_], options)
  : run('pnpm', arguments_, options)

await runPnpm(['--dir', 'admin', 'build'], {
  cwd: repositoryDirectory,
  env: {
    ...process.env,
    VITE_API_BASE_URL: productionApiUrl,
  },
})

const adminDistDirectory = resolve(repositoryDirectory, 'admin/dist')
const adminIndex = await readFile(resolve(adminDistDirectory, 'index.html'), 'utf8')
const adminEntry = adminIndex.match(/\/assets\/(index-[^"']+\.js)/)?.[1]
if (!adminEntry) {
  throw new Error('The embedded desktop build could not identify the admin entry bundle.')
}
const adminBundle = await readFile(resolve(adminDistDirectory, 'assets', adminEntry), 'utf8')
if (!adminBundle.includes(productionApiUrl)) {
  throw new Error(`The embedded desktop build is missing ${productionApiUrl}.`)
}

await runPnpm([
  'exec',
  'tauri',
  'build',
  '--config',
  embeddedBuildConfig,
  ...process.argv.slice(2),
])
