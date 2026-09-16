// The copy of the Nessie Executor menu bar app that Nessie Desktop nests inside
// its own bundle, so a Mac with Nessie Desktop installs nothing extra to become
// an executor.
//
// The app itself is built by its own producer — executor/menubar-macos/scripts/
// build-app.sh, which prints the .app path as its last stdout line — and this
// script only decides where the desktop wants it and seals it before Tauri seals
// the bundle around it. That order is not a preference: macOS code signing is
// inside-out, and an enclosing bundle signed over unsigned nested code fails
// `codesign --verify --deep --strict` and notarization both.
//
// The staged path is what desktop/src-tauri/tauri.executor-menubar.conf.json maps
// to `Contents/Library/LoginItems/Nessie Executor.app`, which is where macOS
// expects a menu bar helper and the only place `SMAppService.loginItem` can
// register one.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryDirectory = resolve(desktopDirectory, '..')

/** Where the nested helper is staged, and the name Tauri copies it under. */
export const MENU_BAR_APP_NAME = 'Nessie Executor.app'
export const STAGING_DIRECTORY = resolve(desktopDirectory, 'src-tauri/resources/executor-menubar')
/**
 * Xcode's DerivedData, kept out of the staging directory: everything under
 * `resources/` is a bundle input, and an intermediate build tree is not one.
 */
const BUILD_DIRECTORY = resolve(desktopDirectory, 'src-tauri/target/executor-menubar-build')
/** Relative to the enclosing `Contents` directory — Tauri's own base for `files`. */
export const NESTED_BUNDLE_PATH = `Library/LoginItems/${MENU_BAR_APP_NAME}`

const fail = (message) => {
  throw new Error(message)
}

const run = (command, argumentVector, options = {}) => {
  const completion = spawnSync(command, argumentVector, { encoding: 'utf8', ...options })
  if (completion.error) fail(`${command} could not be run: ${completion.error.message}`)
  if (completion.status !== 0) {
    fail(`${command} ${argumentVector.join(' ')} failed with status ${completion.status}.\n${completion.stderr ?? ''}`)
  }
  return completion.stdout ?? ''
}

/**
 * The last stdout line of build-app.sh is its contract: every diagnostic that
 * script writes goes to stderr precisely so this can be read without parsing.
 */
const buildMenuBarApp = () => {
  const output = run(
    resolve(repositoryDirectory, 'executor/menubar-macos/scripts/build-app.sh'),
    ['--configuration', 'Release', '--output', BUILD_DIRECTORY],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const built = output.trim().split('\n').at(-1)
  if (!built || !existsSync(built)) {
    fail('The menu bar app build printed no usable bundle path.')
  }
  return built
}

/**
 * Sealed here, with the same `Developer ID Application` identity and hardened
 * runtime the enclosing app uses, and with the helper's own entitlements rather
 * than the desktop's. `codesign --deep` on the outer bundle would apply the
 * outer entitlements to this nested app, which is why the nesting is signed
 * before Tauri ever sees it and never re-signed afterwards.
 *
 * A host with no identity stages an unsigned bundle and says so. That build is
 * for inspection only — docs/standards/build-and-release.md forbids presenting
 * an unsigned or ad-hoc macOS bundle as installable.
 */
const signNestedApp = (appPath) => {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? process.env.NESSIE_EXECUTOR_SIGNING_IDENTITY
  const teamId = process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID
  if (!identity) {
    console.warn(
      'prepare-executor-menubar: no APPLE_SIGNING_IDENTITY — the nested menu bar app is UNSIGNED. This bundle is for local inspection and is not installable.',
    )
    return
  }
  if (identity === '-') {
    fail('The nested menu bar app must not be ad-hoc signed. Set a Developer ID Application identity or build without it for inspection.')
  }
  if (!teamId || !/^[A-Za-z0-9]+$/.test(teamId)) {
    fail('Set NESSIE_DESKTOP_SIGNING_TEAM_ID to the trusted Apple Developer team identifier before signing the nested menu bar app.')
  }
  run('/usr/bin/codesign', [
    '--force',
    '--timestamp',
    '--options', 'runtime',
    '--entitlements', resolve(repositoryDirectory, 'executor/packaging/macos/nessie-executor-menubar.entitlements'),
    '--sign', identity,
    appPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: ['ignore', 'inherit', 'inherit'] })
  const details = run('/usr/bin/codesign', ['-dvv', appPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = `${details}`.split('\n')
  if (!lines.some((line) => line.startsWith('Authority=Developer ID Application:'))
    || !lines.some((line) => line.trim() === `TeamIdentifier=${teamId}`)) {
    fail('The nested menu bar app is not signed by the configured Developer ID team.')
  }
}

export const prepareNestedMenuBarApp = () => {
  if (process.platform !== 'darwin') {
    fail('The nested menu bar app can only be prepared on macOS.')
  }
  const built = buildMenuBarApp()
  const staged = resolve(STAGING_DIRECTORY, MENU_BAR_APP_NAME)
  rmSync(staged, { force: true, recursive: true })
  mkdirSync(STAGING_DIRECTORY, { recursive: true })
  // -R, not a rename: the built bundle stays where its build directory is, so a
  // rebuild does not depend on what a previous run moved.
  run('/bin/cp', ['-R', built, staged])
  for (const required of [
    'Contents/Info.plist',
    'Contents/MacOS/Nessie Executor',
    'Contents/Resources/executor-runtime/manifest.json',
    'Contents/Resources/executor-runtime/nessie-executor.cjs',
    'Contents/Resources/executor-runtime/node',
  ]) {
    if (!existsSync(resolve(staged, required))) {
      fail(`The staged menu bar app is missing ${required}.`)
    }
  }
  signNestedApp(staged)
  return staged
}

// Imported by tests for its contract; run directly by the build scripts.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(prepareNestedMenuBarApp())
}
