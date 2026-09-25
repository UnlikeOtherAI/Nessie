#!/usr/bin/env node
/**
 * `pnpm --filter @nessie/executor test`: the suite as `node --test` runs it,
 * over the globs this script is handed. On Linux and macOS that is all it
 * does, so CI runs exactly what it ran before.
 *
 * On Windows it then runs the files with executor-state tests a second time,
 * where they can pass rather than skip. Executor state there is owner-only
 * through a DACL that only the native helper sets and reads, and the executor
 * runs the helper only as an installed package would: beside the Node running
 * the process, with `NESSIE_EXECUTOR_PACKAGED_CLI=1` (`state-security.ts`
 * refuses anything else, on purpose). So when `executor/native/target/release`
 * holds a helper built with `cargo build --release`, this keeps a copy of the
 * running Node beside it and runs those files under that copy with the
 * marker set — the recipe desktop-windows.yml follows for
 * `control-plane-e2e.test.ts`. Without a built helper they stay skipped, and
 * this says how to build one. The files are the ones that name
 * `WINDOWS_STATE_HELPER_SKIP` (`test/windows-prerequisites.ts`).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXECUTOR = join(dirname(fileURLToPath(import.meta.url)), '..')

const nodeTest = (node, files, env) => spawnSync(
  node, ['--test', '--test-concurrency=4', '--test-force-exit', '--import', 'tsx', ...files],
  { cwd: EXECUTOR, env, stdio: 'inherit' },
).status ?? 1

const suite = nodeTest(process.execPath, process.argv.slice(2), process.env)
if (process.platform !== 'win32') process.exit(suite)

const release = join(EXECUTOR, 'native', 'target', 'release')
if (!existsSync(join(release, 'nessie-executor-native.exe'))) {
  console.log('\nThe executor-state tests above skipped: no native helper is built in executor/native/target/release.'
    + ' Build one with `cargo build --release` in executor/native and they run here too.')
  process.exit(suite)
}
// The same Node as this one, refreshed when this one changed version.
const node = join(release, 'node.exe')
const version = existsSync(node) ? spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout?.trim() : undefined
if (version !== process.version) copyFileSync(process.execPath, node)

const files = readdirSync(join(EXECUTOR, 'test')).filter((name) => name.endsWith('.test.ts')).sort()
  .filter((name) => readFileSync(join(EXECUTOR, 'test', name), 'utf8').includes('WINDOWS_STATE_HELPER_SKIP'))
  .map((name) => join('test', name))
console.log(`\nThe ${files.length} files with executor-state tests, again: under ${node}, beside the helper built there,`
  + ' with NESSIE_EXECUTOR_PACKAGED_CLI=1.')
const state = nodeTest(node, files, { ...process.env, NESSIE_EXECUTOR_PACKAGED_CLI: '1' })
process.exit(suite !== 0 ? suite : state)
