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
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
  ' executor command, its pinned Node runtime with a sha256 manifest, and the',
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

  // Reserved placement for the sandbox artifacts the Firecracker backend will
  // ship (firecracker, jailer, the guest kernel/initrd/runtime bundle). They
  // are a later wave of the plan and no binary is added here; the directory
  // exists so the install path, ownership rules, and documentation are already
  // the ones those artifacts will land in.
  await mkdir(join(stagingDirectory, INSTALL_PREFIX, 'resources'), { mode: 0o755, recursive: true })

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
