import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { promoteImage } from './promote-ci-image.mjs'

const sha = 'a'.repeat(40)
const branchSha = 'c'.repeat(40)
const options = { archive: '/tmp/image.tar', name: 'app', sha, prefix: 'ghcr.io/unlikeotherai/nessie' }
const labelled = (revision) => JSON.stringify([{ Config: { Labels: { 'org.opencontainers.image.revision': revision } } }])

test('publishes the loaded, revision-verified image without rebuilding', () => {
  const commands = []
  promoteImage(options, (args) => {
    commands.push(args)
    return labelled(sha)
  })
  assert.deepEqual(commands, [
    ['load', '--input', '/tmp/image.tar'],
    ['image', 'inspect', `nessie-ci-app:${sha}`],
    ['tag', `nessie-ci-app:${sha}`, `ghcr.io/unlikeotherai/nessie-app:${sha}`],
    ['push', `ghcr.io/unlikeotherai/nessie-app:${sha}`],
  ])
})

// The gate verified main through a branch run on the identical tree: the image
// carries the branch commit, and is published as the main commit.
test('publishes a tree-verified branch image under the gated main SHA', () => {
  const commands = []
  promoteImage({ ...options, sourceSha: branchSha }, (args) => {
    commands.push(args)
    return labelled(branchSha)
  })
  assert.deepEqual(commands, [
    ['load', '--input', '/tmp/image.tar'],
    ['image', 'inspect', `nessie-ci-app:${branchSha}`],
    ['tag', `nessie-ci-app:${branchSha}`, `ghcr.io/unlikeotherai/nessie-app:${sha}`],
    ['push', `ghcr.io/unlikeotherai/nessie-app:${sha}`],
  ])
})

test('missing or mismatched revision never reaches tag or push', () => {
  for (const [sourceSha, labels] of [
    [sha, {}],
    [sha, { 'org.opencontainers.image.revision': 'b'.repeat(40) }],
    // A branch image must carry the branch commit, not the main one.
    [branchSha, { 'org.opencontainers.image.revision': sha }],
  ]) {
    const commands = []
    assert.throws(() => promoteImage({ ...options, sourceSha }, (args) => {
      commands.push(args[0])
      return JSON.stringify([{ Config: { Labels: labels } }])
    }), /revision/)
    assert.deepEqual(commands, ['load', 'image'])
  }
})

test('an invalid source identity is refused before anything loads', () => {
  for (const sourceSha of ['', 'main', 'C'.repeat(40)]) {
    const commands = []
    assert.throws(() => promoteImage({ ...options, sourceSha }, (args) => {
      commands.push(args)
      return '[]'
    }), /Invalid production image identity/)
    assert.deepEqual(commands, [])
  }
})

test('Deploy downloads from the selected trusted run, with no rebuild on artifact failure', async () => {
  const deploy = parse(await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'))
  const steps = deploy.jobs.build.steps
  const download = steps.find((step) => step.uses === 'actions/download-artifact@v4')
  assert.equal(download.with['run-id'], '${{ needs.gate.outputs.ci_run_id }}')
  assert.equal(download['continue-on-error'], undefined)
  const build = steps.find((step) => step.uses === 'docker/build-push-action@v6')
  assert.equal(build.if, "steps.contract.outputs.artifacts == 'false'")
  const publish = steps.find((step) => step.name === 'Publish verified CI image')
  assert.equal(publish.if, "steps.contract.outputs.artifacts == 'true'")
  assert.equal(publish.env.IMAGE_SHA, '${{ needs.gate.outputs.sha }}')
  assert.equal(publish.env.IMAGE_SOURCE_SHA, '${{ needs.gate.outputs.source_sha }}')
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const upload = ci.jobs.images.steps.find((step) => step.uses === 'actions/upload-artifact@v4')
  // Every run that built its images saves them — main for a week, a branch for
  // a day, long enough for its merge to be promoted from them.
  assert.equal(upload.if, "steps.scope.outputs.images == '1'")
  assert.equal(upload.with['retention-days'], "${{ github.ref == 'refs/heads/main' && 7 || 1 }}")
  assert.equal(upload.with.name, download.with.name)
  assert.equal(upload.with.overwrite, true) // full and failed-job reruns both work
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.ok(ci.jobs['test-legs'].steps.some((step) => step.run?.includes('node scripts/ci-tests.mjs')))
})
