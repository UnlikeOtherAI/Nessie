import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'
import { archiveName, homebrewFormula, releaseVersion, REPOSITORY } from './release-plan.mjs'
import { assertDeveloperIdSignature, notarizeArguments, resolveBuildMode } from '../macos/dmg-plan.mjs'

const run = promisify(execFile)
const version = releaseVersion()
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build the CLI on an Apple Silicon Mac.')
const mode = resolveBuildMode(process.env, { requireSigned: true })
const { identity, teamId: team } = mode
const output = join(REPOSITORY, 'dist/executor-cli')
const payload = join(output, 'macos-payload')
await mkdir(payload, { recursive: true })
const runtime = await prepareExecutorRuntime({
  entryPoint: join(REPOSITORY, 'executor/src/index.ts'),
  nativeHelperPath: join(REPOSITORY, 'executor/native/target/release/nessie-executor-native'),
  outputDirectory: join(payload, 'runtime'), executorVersion: version, executorAppleTeamId: team,
})
for (const [file, entitlements] of [
  [runtime.nodePath, 'executor/packaging/macos/packaged-node.entitlements'],
  [join(runtime.runtimeDirectory, 'nessie-executor-native'), null],
]) {
  await run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity,
    ...(entitlements ? ['--entitlements', join(REPOSITORY, entitlements)] : []), file])
  await run('codesign', ['--verify', '--strict', file])
  const { stderr } = await run('codesign', ['-dvv', file])
  assertDeveloperIdSignature(stderr, team)
}
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')
await writeFile(runtime.manifestPath, JSON.stringify({
  ...runtime.manifest, nodeSha256: await digest(runtime.nodePath),
  nativeHelperSha256: await digest(join(runtime.runtimeDirectory, 'nessie-executor-native')),
}, null, 2))
await copyFile(join(REPOSITORY, 'LICENSE'), join(payload, 'LICENSE'))
const zip = join(output, `nessie-executor_${version}_notary.zip`)
await run('ditto', ['-c', '-k', '--keepParent', payload, zip])
const result = await run('xcrun', [...notarizeArguments(mode.notary, zip), '--output-format', 'json'])
if (JSON.parse(result.stdout).status !== 'Accepted') throw new Error('Apple did not accept the CLI for notarization.')
// CLI Mach-O tickets are retrieved online by Gatekeeper; tar archives cannot be stapled.
await run('spctl', ['--assess', '--type', 'execute', '--verbose', runtime.nodePath])
const archive = join(output, archiveName(version))
await run('tar', ['-czf', archive, '-C', payload, '.'])
const sha256 = await digest(archive)
await writeFile(`${archive}.sha256`, `${sha256}  ${archiveName(version)}\n`)
await mkdir(join(output, 'Formula'), { recursive: true })
await writeFile(join(output, 'Formula/nessie-executor.rb'), homebrewFormula(version, sha256))
process.stdout.write(`${archive}\n`)
