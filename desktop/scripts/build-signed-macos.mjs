// Build the desktop DMG with the same inside-out signer as the executor app.
import { execFile, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareExecutorRuntime } from '../../executor/scripts/prepare-runtime.mjs'
import { signMacApp, notarizeAndStaple } from '../../executor/packaging/macos/sign-app.mjs'
import {
  codesignArguments, gatekeeperAssessArguments, hdiutilArguments, resolveBuildMode,
} from '../../executor/packaging/macos/dmg-plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.platform !== 'darwin') throw new Error('Build and sign the Mac desktop on macOS.')
const mode = resolveBuildMode(process.env, { requireSigned: true })
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('The direct desktop updater signing key is required.')
const target = process.argv[2]
const targets = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }
if (target !== targets[process.arch]) throw new Error('Build each Mac architecture on its native host.')
const run = promisify(execFile)
const execute = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`)
}
const config = JSON.parse(await readFile(join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'))
await prepareExecutorRuntime({
  entryPoint: join(root, 'executor/src/index.ts'),
  outputDirectory: join(root, 'desktop/src-tauri/resources/executor-runtime'),
  executorVersion: config.version,
})
// Build an intermediate app, then seal it ourselves. No ad-hoc installer is produced.
execute('pnpm', ['--dir', 'desktop', 'exec', 'tauri', 'build', '--target', target,
  '--features', 'direct-updater', '--bundles', 'app', '--no-sign',
  '--config', 'src-tauri/tauri.direct-updater.conf.json'])
const app = join(root, 'desktop/src-tauri/target', target, 'release/bundle/macos/Nessie.app')
const runtime = await prepareExecutorRuntime({
  entryPoint: join(root, 'executor/src/index.ts'),
  outputDirectory: join(app, 'Contents/Resources/executor-runtime'),
  executorVersion: config.version,
})
await signMacApp(app, mode, runtime)
await notarizeAndStaple(app, mode.notary)
await run('spctl', gatekeeperAssessArguments(app, 'exec'))
const output = join(root, 'dist/desktop-macos')
const stage = join(output, 'image')
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await run('ditto', [app, join(stage, 'Nessie.app')])
await symlink('/Applications', join(stage, 'Applications'))
const name = `Nessie-macOS-${process.arch === 'arm64' ? 'Apple-Silicon' : 'Intel'}`
const dmg = join(output, `${name}.dmg`)
await run('hdiutil', hdiutilArguments({ output: dmg, sourceDirectory: stage, volumeName: 'Nessie' }))
await run('codesign', codesignArguments({ identity: mode.identity, path: dmg }))
await notarizeAndStaple(dmg, mode.notary)
await run('spctl', gatekeeperAssessArguments(dmg, 'open'))
const archive = join(output, `${name}.app.tar.gz`)
await run('tar', ['-czf', archive, '-C', dirname(app), 'Nessie.app'])
execute('pnpm', ['--dir', 'desktop', 'exec', 'tauri', 'signer', 'sign', archive])
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'))
process.stdout.write(`${dmg}\n`)
