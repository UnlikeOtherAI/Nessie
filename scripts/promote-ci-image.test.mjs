import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { promoteImage } from './promote-ci-image.mjs'

const sha = 'a'.repeat(40)
const options = { archive: '/tmp/image.tar', name: 'app', sha, prefix: 'ghcr.io/unlikeotherai/nessie' }

test('publishes the loaded, revision-verified image without rebuilding', () => {
  const commands = []
  promoteImage(options, (args) => {
    commands.push(args)
    return JSON.stringify([{ Config: { Labels: { 'org.opencontainers.image.revision': sha } } }])
  })
  assert.deepEqual(commands, [
    ['load', '--input', '/tmp/image.tar'],
    ['image', 'inspect', `nessie-ci-app:${sha}`],
    ['tag', `nessie-ci-app:${sha}`, `ghcr.io/unlikeotherai/nessie-app:${sha}`],
    ['push', `ghcr.io/unlikeotherai/nessie-app:${sha}`],
  ])
})

test('missing or mismatched revision never reaches tag or push', () => {
  for (const labels of [{}, { 'org.opencontainers.image.revision': 'b'.repeat(40) }]) {
    const commands = []
    assert.throws(() => promoteImage(options, (args) => {
      commands.push(args[0])
      return JSON.stringify([{ Config: { Labels: labels } }])
    }), /revision/)
    assert.deepEqual(commands, ['load', 'image'])
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
  assert.equal(steps.find((step) => step.name === 'Publish verified CI image').if,
    "steps.contract.outputs.artifacts == 'true'")
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const upload = ci.jobs.images.steps.find((step) => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.if, "github.ref == 'refs/heads/main'")
  assert.equal(upload.with.name, download.with.name)
  assert.equal(upload.with.overwrite, true) // full and failed-job reruns both work
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(ci.jobs.test.env.WORKER_TEST_DATABASE_URL.endsWith('/nessie_test_worker'), true)
  assert.ok(ci.jobs.test.steps.some((step) => step.run?.includes('node scripts/ci-tests.mjs')))
})
