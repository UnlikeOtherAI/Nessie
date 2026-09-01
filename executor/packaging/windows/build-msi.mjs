// Builds NessieExecutor_<version>_x64.msi: the standalone `service` supervisor
// for Windows computers with no desktop app.
//
// It stages exactly what the installer ships — the packaged runtime from the one
// shared preparation, plus the two Rust binaries this package adds — and then
// hands that directory to the WiX toolset. Nothing here signs anything: signing
// is a release-pipeline step with its own credentials, and a build that signed
// itself would be attesting to nothing.
//
// This runs on Windows only, and says so immediately rather than failing three
// steps later on a missing `.exe`.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'
import { BUILT_BINARIES, msiFileName, msiVersion } from './msi-plan.mjs'

const run = promisify(execFile)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')
const repositoryDirectory = resolve(executorDirectory, '..')
const outputDirectory = resolve(repositoryDirectory, 'dist')
const stagingDirectory = join(outputDirectory, 'nessie-executor-windows')

/**
 * The WiX major this authoring targets. WiX is a .NET global tool, so the
 * version is pinned rather than "whatever is installed": its schema and its CLI
 * both change between majors.
 */
const WIX_VERSION = '7.0.0'

const requireWindows = () => {
  if (process.platform !== 'win32') {
    throw new Error(
      'The Nessie Executor MSI is built on Windows. It needs the MSVC toolchain for its two Rust '
      + 'binaries, a Windows Node 22 to copy as the packaged runtime, and the WiX toolset '
      + `(dotnet tool install --global wix --version ${WIX_VERSION}). `
      + `This host is ${process.platform}.`,
    )
  }
}

const packageVersion = async () => msiVersion(
  process.env.NESSIE_EXECUTOR_VERSION
  ?? JSON.parse(await readFile(join(executorDirectory, 'package.json'), 'utf8')).version,
)

const cargoRelease = async (manifestDirectory) => {
  await run('cargo', ['build', '--release'], { cwd: manifestDirectory })
}

/**
 * Signs the binaries this package builds, in place, before they are staged.
 *
 * The order matters: the native helper's bytes are pinned in the runtime
 * manifest, so it has to be signed *before* the manifest hashes it, or the
 * shipped file would never match its own manifest. `NESSIE_WINDOWS_SIGN_COMMAND`
 * carries `%1` where the file path goes, the same shape Tauri's `signCommand`
 * uses, so one configured identity signs everything on a release runner. With no
 * command configured this is a development build and nothing is signed —
 * which is exactly what makes it refuse executor controls at runtime.
 */
const signBuiltBinaries = async (paths) => {
  const template = process.env.NESSIE_WINDOWS_SIGN_COMMAND
  if (!template) return
  if (!template.includes('%1')) {
    throw new Error('NESSIE_WINDOWS_SIGN_COMMAND must contain %1, the file being signed.')
  }
  for (const path of paths) {
    await run(template.replace('%1', `"${path}"`), { shell: true })
  }
}

/**
 * The tray is a Tauri application, so its executable is produced by the Tauri
 * CLI rather than by cargo directly: `--bundles none` builds and signs nothing,
 * leaving the binary for the MSI to carry.
 */
const buildTray = async () => {
  await run('pnpm', ['exec', 'tauri', 'build', '--bundles', 'none'], {
    cwd: join(executorDirectory, 'tray-windows'),
    shell: true,
  })
}

const stage = async () => {
  await rm(stagingDirectory, { force: true, recursive: true })
  await mkdir(stagingDirectory, { recursive: true })

  await cargoRelease(join(executorDirectory, 'native'))
  await cargoRelease(join(executorDirectory, 'service-windows'))
  await buildTray()

  const nativeHelperPath = join(
    executorDirectory,
    'native/target/release/nessie-executor-native.exe',
  )
  const sources = {
    'nessie-executor-service.exe': join(
      executorDirectory,
      'service-windows/target/release/nessie-executor-service.exe',
    ),
    'nessie-executor-tray.exe': join(
      executorDirectory,
      'tray-windows/src-tauri/target/release/nessie-executor-tray.exe',
    ),
  }
  await signBuiltBinaries([nativeHelperPath, ...BUILT_BINARIES.map((name) => sources[name])])

  // One producer for the runtime layout and its manifest, shared with the
  // desktop bundle and the Linux package. The native helper is pinned in that
  // manifest because the service secures its state root through it — and it is
  // hashed after signing, so the shipped bytes are the ones the manifest names.
  await prepareExecutorRuntime({
    entryPoint: join(executorDirectory, 'src/index.ts'),
    nativeHelperPath,
    outputDirectory: stagingDirectory,
    platform: 'win32',
  })

  for (const name of BUILT_BINARIES) {
    await copyFile(sources[name], join(stagingDirectory, name))
  }
}

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

requireWindows()
const version = await packageVersion()
const name = msiFileName(version)
const packagePath = join(outputDirectory, name)

await mkdir(outputDirectory, { recursive: true })
await stage()
await run('wix', [
  'build',
  join(packagingDirectory, 'nessie-executor.wxs'),
  '-arch', 'x64',
  '-d', `Version=${version}`,
  '-d', `StagingDir=${stagingDirectory}`,
  // The tray's autostart entry is a per-user registry value in a per-machine
  // package. That is the intent — the service serves everyone, the tray is one
  // person's control surface — and these two validators exist to warn about
  // exactly that shape, so they are suppressed by name rather than by turning
  // validation off.
  '-sice:ICE38',
  '-sice:ICE64',
  '-o', packagePath,
], { shell: true })
await rm(stagingDirectory, { force: true, recursive: true })
await writeFile(`${packagePath}.sha256`, `${await sha256File(packagePath)}  ${name}\n`, {
  mode: 0o644,
})

process.stdout.write(`${packagePath}\n${packagePath}.sha256\n`)
