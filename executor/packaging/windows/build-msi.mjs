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
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareExecutorRuntime, resolveWindowsPackagedNodeLicense } from '../../scripts/prepare-runtime.mjs'
import { signWindowsArtifacts } from '../../scripts/windows-sign.mjs'
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

/**
 * The sandbox payload: the Hyper-V bridge, the four pinned PowerShell scripts,
 * the guest kernel, the portable initrd builder and the Linux guest init it
 * assembles. `guest/init` is a *Linux* binary — it is never run on this
 * machine, only placed inside the initrd — while `build-initrd.exe` runs on the
 * host, which is why the two are cross-compiled for different targets.
 *
 * The kernel is not built here: it needs a Linux toolchain
 * (`executor/guest/kernel/build.sh`), so CI builds it in a Linux job and hands
 * it over through NESSIE_GUEST_KERNEL.
 */
const stageResources = async (destination) => {
  await mkdir(join(destination, 'guest'), { recursive: true })
  await mkdir(join(destination, 'scripts'), { recursive: true })

  await cargoRelease(join(executorDirectory, 'hyperv-bridge'))
  const bridgePath = join(executorDirectory, 'hyperv-bridge/target/release/nessie-hyperv-bridge.exe')
  await signWindowsArtifacts([bridgePath])
  await copyFile(bridgePath, join(destination, 'nessie-hyperv-bridge.exe'))

  const guestDirectory = join(executorDirectory, 'guest')
  const initrdBuilderPath = join(destination, 'guest/build-initrd.exe')
  await run('go', ['build', '-trimpath', '-o', initrdBuilderPath, './cmd/build-initrd'], {
    cwd: guestDirectory,
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'windows' },
  })
  await signWindowsArtifacts([initrdBuilderPath])
  await run('go', ['build', '-trimpath', '-o', join(destination, 'guest/init'), '.'], {
    cwd: guestDirectory,
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'linux' },
  })

  const kernelPath = process.env.NESSIE_GUEST_KERNEL
  if (!kernelPath) {
    throw new Error(
      'Set NESSIE_GUEST_KERNEL to the bzImage built by executor/guest/kernel/build.sh. '
      + 'Without a guest kernel the package could install a sandbox that cannot boot.',
    )
  }
  await copyFile(kernelPath, join(destination, 'guest/bzImage'))

  for (const name of ['create.ps1', 'remove.ps1', 'start.ps1', 'stop.ps1']) {
    await copyFile(join(packagingDirectory, 'scripts', name), join(destination, 'scripts', name))
  }

}

/**
 * One SHA-256 per shipped sandbox resource, so an integrity check can say which
 * file changed rather than only that something did. It is what the daemon
 * checks a PowerShell script against before running it. `manifest.json` is
 * excluded from its own listing, and paths are recorded with forward slashes so
 * one reader serves both packages.
 */
const resourceManifest = async (directory) => {
  const files = []
  const walk = async (current) => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name !== 'manifest.json') {
        files.push({ path: relative(directory, path).split('\\').join('/'), sha256: await sha256File(path) })
      }
    }
  }
  await walk(directory)
  return { files, version: 1 }
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
  await signWindowsArtifacts([nativeHelperPath, ...BUILT_BINARIES.map((name) => sources[name])])

  // One producer for the runtime layout and its manifest, shared with the
  // desktop bundle and the Linux package. The native helper is pinned in that
  // manifest because the service secures its state root through it — and it is
  // hashed after signing, so the shipped bytes are the ones the manifest names.
  await prepareExecutorRuntime({
    entryPoint: join(executorDirectory, 'src/index.ts'),
    nativeHelperPath,
    nodeLicenseContents: await resolveWindowsPackagedNodeLicense(),
    outputDirectory: stagingDirectory,
    platform: 'win32',
  })

  for (const name of BUILT_BINARIES) {
    await copyFile(sources[name], join(stagingDirectory, name))
  }

  const resourcesDirectory = join(stagingDirectory, 'resources')
  await stageResources(resourcesDirectory)
  await writeFile(
    join(resourcesDirectory, 'manifest.json'),
    `${JSON.stringify(await resourceManifest(resourcesDirectory), null, 2)}\n`,
  )
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
