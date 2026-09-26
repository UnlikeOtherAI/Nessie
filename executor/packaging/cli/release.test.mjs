import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { candidateFiles, verifyCandidate } from './candidate.mjs'
import { archiveName, homebrewFormula, linuxPackage, releaseVersion } from './release-plan.mjs'

test('release input cannot change artifact paths or insert formula code', () => {
  for (const value of ['', '../1.0.0', '1.0', 'v1.0.0', '01.0.0', '1.0.0";system("id")']) {
    assert.throws(() => releaseVersion(value))
  }
  assert.throws(() => homebrewFormula('1.0.0', 'unverified'))
  assert.equal(archiveName('1.2.3'), 'nessie-executor_1.2.3_darwin_arm64.tar.gz')
})

test('native Linux packages keep the runtime and service at their trusted locations', () => {
  for (const format of ['deb', 'rpm']) {
    const config = linuxPackage('1.0.0', '/build/payload', format, '/temporary/signing-key.asc')
    assert.deepEqual(config.contents, [{ src: '/build/payload/usr/', dst: '/usr', type: 'tree' }])
    assert.ok(config.depends.includes('tmux'))
    assert.ok(config.depends.includes('systemd'))
    assert.equal(config.rpm.signature.key_file, '/temporary/signing-key.asc')
  }
})

test('publication rejects verification keys, altered payloads and mismatched source metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-candidate-'))
  try {
    const files = {}
    for (const file of candidateFiles('darwin', '1.2.3')) {
      await mkdir(dirname(join(directory, file)), { recursive: true })
      await writeFile(join(directory, file), file)
      files[file] = createHash('sha256').update(file).digest('hex')
    }
    const path = join(directory, 'darwin-candidate.json')
    const candidate = { platform: 'darwin', version: '1.2.3', commit: 'a'.repeat(40), signing: 'verification', files }
    await writeFile(path, JSON.stringify(candidate))
    await assert.rejects(verifyCandidate(directory, 'darwin', '1.2.3'), /Verification builds/)
    candidate.signing = 'release'
    await writeFile(path, JSON.stringify(candidate))
    assert.equal((await verifyCandidate(directory, 'darwin', '1.2.3')).commit, candidate.commit)
    await assert.rejects(verifyCandidate(directory, 'darwin', '1.2.4'), /matching production-signed/)
    await writeFile(join(directory, 'Formula/nessie-executor.rb'), 'changed after signing')
    await assert.rejects(verifyCandidate(directory, 'darwin', '1.2.3'), /Candidate file changed/)
    candidate.files['unexpected-file'] = 'b'.repeat(64)
    await writeFile(path, JSON.stringify(candidate))
    await assert.rejects(verifyCandidate(directory, 'darwin', '1.2.3'), /file set differs/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('build workflow cannot publish a release or silently produce an unsigned Mac archive', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/executor-cli.yml', import.meta.url), 'utf8')
  assert.match(workflow, /contents: read/)
  assert.doesNotMatch(workflow, /contents: write|publish\.mjs|gh release create/)
  assert.match(workflow, /NESSIE_EXECUTOR_SIGNING_IDENTITY/)
})
