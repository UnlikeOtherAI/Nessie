// Builds NessieExecutor_<version>_<arch>.dmg: the downloadable installer for the
// macOS menu bar app, which is how a person with no terminal reaches an
// executor's settings, what it may reach, and the tools it may run.
//
// The DMG is the macOS trust root, and unlike the Linux package it is one Apple
// itself vouches for: a `Developer ID Application` signature over a hardened
// runtime, a notarization ticket stapled to both the app and the image, and a
// Gatekeeper assessment that actually passes. That last check is the point — a
// successful `notarytool submit` says a ticket was issued, not that this
// artifact carries it.
//
// There is no third outcome. A host without those credentials may build only the
// development image, whose file name, volume name and closing banner all say it
// may not be installed. Nothing here ad-hoc signs and calls the result
// distributable: docs/standards/build-and-release.md → "macOS release-signing
// policy" is the rule, and this file is where it binds for this artifact.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'
import {
  APPLICATIONS_SYMLINK_NAME,
  APPLICATIONS_SYMLINK_TARGET,
  APP_ENTITLEMENTS_FILE,
  BUILD_APP_SCRIPT,
  DEVELOPMENT_MARKER,
  EXECUTOR_RUNTIME_DIRECTORY,
  RUNTIME_ENTITLEMENTS_FILE,
  assertBundleIdentifier,
  assertDeveloperIdSignature,
  codesignArguments,
  codesignVerifyArguments,
  dmgFileName,
  dmgVolumeName,
  gatekeeperAssessArguments,
  hdiutilArguments,
  missingBuildScriptMessage,
  notarizeArguments,
  resolveBuildMode,
  resolveDmgVersion,
  stapleArguments,
} from './dmg-plan.mjs'

const run = promisify(execFile)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')
const repositoryDirectory = resolve(executorDirectory, '..')
const outputDirectory = resolve(repositoryDirectory, 'dist')
const stagingDirectory = join(outputDirectory, 'nessie-executor-macos')
const buildDirectory = join(outputDirectory, 'nessie-executor-macos-app')

const requireMacOs = () => {
  if (process.platform !== 'darwin') {
    throw new Error(
      'The Nessie Executor DMG is built on macOS. It needs Xcode\'s command line tools to build '
      + 'and sign the menu bar app, hdiutil to make the image, and notarytool to have Apple vouch '
      + `for it. This host is ${process.platform}. Everything that can be checked anywhere is in `
      + 'executor/packaging/macos/dmg-plan.test.mjs.',
    )
  }
}

const exists = async (path) => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The app's build contract, honoured exactly: the script takes a configuration
 * and an output directory, and prints the absolute path of the built `.app` as
 * the last line of its stdout. A script that prints something else has broken
 * that contract and is told so here, rather than leaving a later step to fail on
 * a path that was never a path.
 */
const buildApp = async () => {
  const scriptPath = resolve(repositoryDirectory, BUILD_APP_SCRIPT)
  if (!await exists(scriptPath)) throw new Error(missingBuildScriptMessage(scriptPath))
  const { stdout } = await run(scriptPath, [
    '--configuration', 'Release',
    '--output', buildDirectory,
  ], { cwd: repositoryDirectory, maxBuffer: 64 * 1024 * 1024 })
  process.stdout.write(stdout)
  const lastLine = stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  if (lastLine === undefined || !lastLine.startsWith('/') || !lastLine.endsWith('.app')) {
    throw new Error(
      `${BUILD_APP_SCRIPT} must print the absolute path of the built .app as the last line of its `
      + `stdout. It printed ${lastLine === undefined ? 'nothing' : `"${lastLine}"`}.`,
    )
  }
  if (!await exists(lastLine)) {
    throw new Error(`${BUILD_APP_SCRIPT} named ${lastLine}, which does not exist.`)
  }
  return lastLine
}

const plistValue = async (appPath, key) => {
  const { stdout } = await run('/usr/libexec/PlistBuddy', [
    '-c', `Print :${key}`,
    join(appPath, 'Contents/Info.plist'),
  ])
  return stdout.trim()
}

/**
 * Every Mach-O the bundle carries, deepest first, with the bundle's own main
 * executable left out: it is sealed by the bundle signature itself, and signing
 * it separately first is exactly how a bundle ends up reporting a valid inner
 * signature and an invalid outer one.
 */
const nestedMachOFiles = async (appPath, mainExecutable) => {
  const { stdout } = await run('/usr/bin/find', [appPath, '-type', 'f'])
  const candidates = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const binaries = []
  for (const path of candidates) {
    if (path === mainExecutable) continue
    const { stdout: kind } = await run('/usr/bin/file', ['--brief', '--mime-type', path])
    if (kind.trim() === 'application/x-mach-binary') binaries.push(path)
  }
  // Deepest first, so a nested binary is always sealed before whatever contains
  // it: signing a child after its parent silently breaks the parent.
  return binaries.sort((left, right) => right.split('/').length - left.split('/').length)
}

/**
 * The packaged runtime, laid into the app by its one producer. The pinned Node,
 * the bundled CLI, its licence and the sha256 manifest are never reconstructed
 * here: the desktop bundle, the Linux package and this installer are three
 * callers of one preparation.
 */
const embedExecutorRuntime = async (appPath) => prepareExecutorRuntime({
  entryPoint: join(executorDirectory, 'src/index.ts'),
  outputDirectory: join(appPath, EXECUTOR_RUNTIME_DIRECTORY),
})

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/**
 * Signs inside-out and then asks Apple's own tools what was produced.
 *
 * The order matters twice over. The packaged Node is signed before the manifest
 * is rewritten, because a signature changes the file and
 * `executor/src/runtime-integrity.ts` refuses to serve from a runtime whose
 * bytes do not match the manifest beside them; and the manifest is rewritten
 * before the bundle is sealed, because a resource edited after sealing breaks
 * the seal.
 */
const signApp = async (appPath, { identity, teamId }, runtime) => {
  const appEntitlements = join(packagingDirectory, APP_ENTITLEMENTS_FILE)
  const runtimeEntitlements = join(packagingDirectory, RUNTIME_ENTITLEMENTS_FILE)
  const mainExecutable = join(appPath, 'Contents/MacOS', await plistValue(appPath, 'CFBundleExecutable'))

  for (const path of await nestedMachOFiles(appPath, mainExecutable)) {
    await run('codesign', codesignArguments({
      entitlements: path === runtime.nodePath ? runtimeEntitlements : appEntitlements,
      identity,
      path,
    }))
  }

  await writeFile(
    runtime.manifestPath,
    `${JSON.stringify({
      ...runtime.manifest,
      executorBundleSha256: await sha256File(runtime.executorBundlePath),
      nodeSha256: await sha256File(runtime.nodePath),
    }, null, 2)}\n`,
    { mode: 0o644 },
  )

  await run('codesign', codesignArguments({ entitlements: appEntitlements, identity, path: appPath }))
  await run('codesign', codesignVerifyArguments(appPath))
  const { stderr } = await run('codesign', ['-dvv', appPath])
  assertDeveloperIdSignature(stderr, teamId)
}

/**
 * The drag-to-Applications layout: the app, and a symlink to /Applications
 * beside it. That is the gesture every Mac user already knows, and it is what
 * gets the installed copy out of Downloads — where a quarantined app behaves
 * differently from the same app in /Applications.
 *
 * `ditto` rather than a file copy: it is the only macOS copy that preserves the
 * extended attributes and hard links a signed bundle's seal is computed over.
 */
const stageImage = async (appPath) => {
  await rm(stagingDirectory, { force: true, recursive: true })
  await mkdir(stagingDirectory, { recursive: true })
  await run('ditto', [appPath, join(stagingDirectory, basename(appPath))])
  await symlink(APPLICATIONS_SYMLINK_TARGET, join(stagingDirectory, APPLICATIONS_SYMLINK_NAME))
}

const notarizeAndStaple = async (path, notary) => {
  process.stdout.write(`Notarizing ${basename(path)} with the ${notary.kind} credential…\n`)
  const { stdout } = await run('xcrun', notarizeArguments(notary, path), {
    maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(stdout)
  if (!/status:\s*Accepted/i.test(stdout)) {
    throw new Error(
      `Notarization of ${basename(path)} was not Accepted. Read the log with `
      + '`xcrun notarytool log <submission-id>`. A rejected submission is never stapled, and this '
      + 'artifact must not be published.',
    )
  }
  await run('xcrun', stapleArguments(path))
  await run('xcrun', ['stapler', 'validate', path])
}

requireMacOs()

// Decided before anything is built: a missing certificate is a first-second
// failure, not a surprise after a long compile.
const mode = resolveBuildMode(process.env, {
  requireSigned: process.argv.includes('--require-signed'),
})

await mkdir(outputDirectory, { recursive: true })
await rm(buildDirectory, { force: true, recursive: true })
await mkdir(buildDirectory, { recursive: true })

const appPath = await buildApp()
assertBundleIdentifier(await plistValue(appPath, 'CFBundleIdentifier'))
const version = resolveDmgVersion({
  bundleVersion: await plistValue(appPath, 'CFBundleShortVersionString'),
  declared: process.env.NESSIE_EXECUTOR_VERSION,
})
const name = dmgFileName(version, process.arch, mode.kind)
const packagePath = join(outputDirectory, name)

const runtime = await embedExecutorRuntime(appPath)

if (mode.kind === 'release') {
  await signApp(appPath, mode, runtime)
  await notarizeAndStaple(appPath, mode.notary)
  await run('spctl', gatekeeperAssessArguments(appPath, 'exec'))
}

await stageImage(appPath)
await run('hdiutil', hdiutilArguments({
  output: packagePath,
  sourceDirectory: stagingDirectory,
  volumeName: dmgVolumeName(version, mode.kind),
}))
await rm(stagingDirectory, { force: true, recursive: true })

if (mode.kind === 'release') {
  await run('codesign', codesignArguments({ identity: mode.identity, path: packagePath }))
  await notarizeAndStaple(packagePath, mode.notary)
  await run('spctl', gatekeeperAssessArguments(packagePath, 'open'))
}

await writeFile(`${packagePath}.sha256`, `${await sha256File(packagePath)}  ${name}\n`, {
  mode: 0o644,
})

if (mode.kind === 'development') {
  process.stderr.write(
    `\n${DEVELOPMENT_MARKER}\n`
    + 'This image carries no Developer ID Application signature and no notarization ticket. macOS '
    + 'will refuse to open the app inside it, and this artifact must never be uploaded to a '
    + 'release, sent to anyone, or described as an installer. It exists so the pipeline can be '
    + `exercised on a machine with no certificate. Missing: ${mode.missing.join(', ')}.\n\n`,
  )
}

process.stdout.write(`${packagePath}\n${packagePath}.sha256\n`)
