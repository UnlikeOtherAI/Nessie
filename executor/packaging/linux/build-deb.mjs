// Builds nessie-executor_<version>_amd64.deb: the standalone `service`
// supervisor for computers with no desktop app.
//
// The package is the Linux trust root. dpkg lays every file down root-owned
// (`--root-owner-group`), apt verifies the repository signature before that
// happens, and the CLI refuses to serve from a runtime that is not in exactly
// that state (executor/src/runtime-integrity.ts). Nothing here signs anything
// itself: a self-attesting hash is not a trust root.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

const run = promisify(execFile)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')
const repositoryDirectory = resolve(executorDirectory, '..')
const outputDirectory = resolve(repositoryDirectory, 'dist')

const ARCHITECTURE = 'amd64'
const INSTALL_PREFIX = 'usr/lib/nessie-executor'
const RESOURCES = 'resources'

// The Firecracker release is pinned by version AND by the SHA-256 its own
// published `<asset>.sha256.txt` states, verified here before a byte is
// unpacked — a pinned version alone trusts whoever can rewrite a release asset.
// Upgrading means changing both constants together, in one commit, after
// re-reading the upstream checksum file.
const FIRECRACKER_VERSION = 'v1.16.1'
const FIRECRACKER_ARCHIVE_SHA256 =
  '382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6'
const FIRECRACKER_MACHINE = 'x86_64'
const FIRECRACKER_URL = 'https://github.com/firecracker-microvm/firecracker/releases/download/'
  + `${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}.tgz`

// The jailer must be the same version as the firecracker binary it execs
// (Firecracker docs/jailer.md), so both come out of the one archive, and the
// backend requires them to sit beside each other in this directory.
const FIRECRACKER_BINARIES = ['firecracker', 'jailer']

const packageVersion = async () => {
  const declared = process.env.NESSIE_EXECUTOR_VERSION
    ?? JSON.parse(await readFile(join(executorDirectory, 'package.json'), 'utf8')).version
  if (!/^[0-9][A-Za-z0-9.+~]*$/.test(declared)) {
    throw new Error(`NESSIE_EXECUTOR_VERSION ${declared} is not a Debian upstream version.`)
  }
  return declared
}

// The copied Node links against the build host's C++ runtime and libc; nothing
// else. `ldd` on the runtime binary is the check that keeps this list honest.
const DEPENDS = ['libc6', 'libgcc-s1', 'libstdc++6']

const control = (version) => [
  'Package: nessie-executor',
  `Version: ${version}`,
  `Architecture: ${ARCHITECTURE}`,
  'Section: utils',
  'Priority: optional',
  'Maintainer: Nessie <desktop@nessie.works>',
  `Depends: ${DEPENDS.join(', ')}`,
  'Homepage: https://nessie.works',
  'Description: Nessie Executor standalone daemon',
  ' Runs a paired Nessie executor as a systemd user service, so a computer with',
  ' no Nessie desktop app can carry out sandboxed work for agents. Ships the',
  ' executor command, its pinned Node runtime with a sha256 manifest, the pinned',
  ' Firecracker hypervisor with its jailer, the Linux guest init, and the',
  ' nessie-executor@.service template.',
  '',
].join('\n')

const LAUNCHER = [
  '#!/bin/sh',
  '# Runs the packaged executor bundle on the packaged Node. Both live beside',
  '# each other under /usr/lib/nessie-executor and the CLI verifies that layout',
  '# before it serves.',
  'set -eu',
  '# The bundle runs its CLI only when it knows it is the packaged one, and the',
  '# same flag arms the packaged-runtime verification.',
  'NESSIE_EXECUTOR_PACKAGED_CLI=1',
  'export NESSIE_EXECUTOR_PACKAGED_CLI',
  `exec /${INSTALL_PREFIX}/node /${INSTALL_PREFIX}/nessie-executor.cjs "$@"`,
  '',
].join('\n')

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/**
 * Downloads and verifies the pinned Firecracker release, then lays its two
 * binaries down under their unversioned names. dpkg makes them root-owned;
 * 0755 keeps them readable and executable by the daemon's own user while only
 * an administrator can replace them, which is what makes the packaged copy a
 * trust root rather than a self-attestation.
 */
const stageFirecracker = async (destination) => {
  await mkdir(destination, { mode: 0o755, recursive: true })
  const archive = join(destination, 'firecracker-release.tgz')
  const response = await fetch(FIRECRACKER_URL, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Downloading ${FIRECRACKER_URL} failed with HTTP ${response.status}.`)
  }
  await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o644 })
  const digest = await sha256File(archive)
  if (digest !== FIRECRACKER_ARCHIVE_SHA256) {
    throw new Error(
      `The Firecracker ${FIRECRACKER_VERSION} archive hashed ${digest}, not the pinned `
      + `${FIRECRACKER_ARCHIVE_SHA256}. Refusing to package an unverified hypervisor.`,
    )
  }
  const unpacked = join(destination, 'unpacked')
  await mkdir(unpacked, { mode: 0o755, recursive: true })
  await run('tar', ['--extract', '--gzip', '--file', archive, '--directory', unpacked])
  const releaseDirectory = join(unpacked, `release-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}`)
  for (const binary of FIRECRACKER_BINARIES) {
    await copyFile(
      join(releaseDirectory, `${binary}-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}`),
      join(destination, binary),
    )
    await chmod(join(destination, binary), 0o755)
  }
  await copyFile(join(releaseDirectory, 'LICENSE'), join(destination, 'LICENSE'))
  await chmod(join(destination, 'LICENSE'), 0o644)
  await rm(archive, { force: true })
  await rm(unpacked, { force: true, recursive: true })
}

/** The Go guest init, built for the architecture this package targets. */
const stageGuest = async (destination) => {
  await mkdir(destination, { mode: 0o755, recursive: true })
  await run('go', ['build', '-trimpath', '-o', join(destination, 'init'), '.'], {
    cwd: join(executorDirectory, 'guest'),
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'linux' },
  })
  await chmod(join(destination, 'init'), 0o755)
}

/**
 * One sha256 per shipped sandbox resource, so an integrity check can say which
 * file changed rather than only that something did. `manifest.json` is excluded
 * from its own listing.
 */
const resourceManifest = async (directory) => {
  const files = []
  const walk = async (current) => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name !== 'manifest.json') {
        files.push({ path: relative(directory, path), sha256: await sha256File(path) })
      }
    }
  }
  await walk(directory)
  return { files, firecrackerVersion: FIRECRACKER_VERSION, version: 1 }
}

const stage = async (stagingDirectory) => {
  await rm(stagingDirectory, { force: true, recursive: true })
  await mkdir(join(stagingDirectory, 'DEBIAN'), { mode: 0o755, recursive: true })
  await mkdir(join(stagingDirectory, 'usr/bin'), { mode: 0o755, recursive: true })
  await mkdir(join(stagingDirectory, 'usr/lib/systemd/user'), { mode: 0o755, recursive: true })

  await prepareExecutorRuntime({
    entryPoint: join(executorDirectory, 'src/index.ts'),
    outputDirectory: join(stagingDirectory, INSTALL_PREFIX),
  })
  await chmod(join(stagingDirectory, INSTALL_PREFIX), 0o755)

  // The sandbox artifacts the Firecracker backend resolves at session start:
  // `resources/firecracker/{firecracker,jailer}` — the executor's stored
  // `vmHelperPath` on Linux is the firecracker binary and the jailer is its
  // sibling — plus the guest init the initrd is built from.
  const resourcesDirectory = join(stagingDirectory, INSTALL_PREFIX, RESOURCES)
  await mkdir(resourcesDirectory, { mode: 0o755, recursive: true })
  await stageFirecracker(join(resourcesDirectory, 'firecracker'))
  await stageGuest(join(resourcesDirectory, 'guest'))
  await writeFile(
    join(resourcesDirectory, 'manifest.json'),
    `${JSON.stringify(await resourceManifest(resourcesDirectory), null, 2)}\n`,
    { mode: 0o644 },
  )

  await writeFile(join(stagingDirectory, 'usr/bin/nessie-executor'), LAUNCHER, { mode: 0o755 })
  await chmod(join(stagingDirectory, 'usr/bin/nessie-executor'), 0o755)
  await copyFile(
    join(packagingDirectory, 'nessie-executor@.service'),
    join(stagingDirectory, 'usr/lib/systemd/user/nessie-executor@.service'),
  )
  await chmod(join(stagingDirectory, 'usr/lib/systemd/user/nessie-executor@.service'), 0o644)
}

const version = await packageVersion()
const name = `nessie-executor_${version}_${ARCHITECTURE}`
const stagingDirectory = join(outputDirectory, name)
const packagePath = join(outputDirectory, `${name}.deb`)

await mkdir(outputDirectory, { mode: 0o755, recursive: true })
await stage(stagingDirectory)
await writeFile(join(stagingDirectory, 'DEBIAN/control'), control(version), { mode: 0o644 })
await run('dpkg-deb', ['--build', '--root-owner-group', stagingDirectory, packagePath])
await rm(stagingDirectory, { force: true, recursive: true })
await writeFile(`${packagePath}.sha256`, `${await sha256File(packagePath)}  ${name}.deb\n`, { mode: 0o644 })

process.stdout.write(`${packagePath}\n${packagePath}.sha256\n`)
