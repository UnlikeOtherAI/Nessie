import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseDocument } from 'yaml'
import { CI_WORKFLOW_NAME, decideDeployGate } from './deploy-gate.mjs'

const repository = 'UnlikeOtherAI/Nessie'
const olderSha = '1'.repeat(40)
const mainSha = '2'.repeat(40)

const successfulRun = (sha = mainSha, overrides = {}) => ({
  conclusion: 'success',
  event: 'push',
  head_branch: 'main',
  head_repository: { full_name: repository },
  head_sha: sha,
  name: CI_WORKFLOW_NAME,
  repository: { full_name: repository },
  ...overrides,
})

const decide = (overrides = {}) => decideDeployGate({
  eventName: 'workflow_run',
  mainSha,
  ref: 'refs/heads/main',
  repository,
  workflowRun: successfulRun(),
  workflowRuns: [successfulRun()],
  ...overrides,
})

const workflow = parseDocument(await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'))
const concurrencyExpression = workflow.get('concurrency').get('group').toString().trim()
const expressionMatch = /^\$\{\{([\s\S]*)\}\}$/.exec(concurrencyExpression)
if (!expressionMatch) throw new Error('deploy concurrency group must be a GitHub expression')

// The workflow uses only GitHub's boolean, equality and format operators. Run
// that exact expression rather than a mirrored policy helper, so a precedence
// change in the deployed YAML cannot silently change serialization semantics.
const concurrencyGroup = (github) => Function(
  'github',
  'format',
  `return (${expressionMatch[1]})`,
)(github, (template, value) => template.replace('{0}', String(value)))

const githubEvent = ({ eventName, ref = 'refs/heads/main', runId, workflowRun }) => ({
  event: { workflow_run: workflowRun },
  event_name: eventName,
  ref,
  repository,
  run_id: runId,
})

test('accepts the exact current main SHA after its trusted CI push succeeds', () => {
  assert.deepEqual(decide(), {
    eligible: true,
    reason: 'current main tip passed trusted CI',
    sha: mainSha,
  })
})

test('does not deploy failed or cancelled CI completions', () => {
  for (const conclusion of ['failure', 'cancelled']) {
    assert.equal(decide({ workflowRun: successfulRun(mainSha, { conclusion }) }).eligible, false)
  }
})

test('manual dispatch obeys the same current-main CI gate', () => {
  assert.equal(decide({ eventName: 'workflow_dispatch', workflowRun: undefined }).sha, mainSha)
  assert.equal(decide({ eventName: 'workflow_dispatch', ref: 'refs/heads/release', workflowRun: undefined }).eligible, false)
})

test('rejects a CI payload from another repository', () => {
  const result = decide({
    workflowRun: successfulRun(mainSha, { head_repository: { full_name: 'attacker/Nessie' } }),
  })
  assert.equal(result.eligible, false)
})

test('rejects CI from a non-main branch', () => {
  const result = decide({ workflowRun: successfulRun(mainSha, { head_branch: 'feature' }) })
  assert.equal(result.eligible, false)
})

test('a delayed older successful event resolves the newer verified main tip', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(olderSha), successfulRun(mainSha)],
  })
  assert.equal(result.sha, mainSha)
})

test('a delayed older event cannot fall back when the newer main tip is unverified', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(olderSha), successfulRun(mainSha, { conclusion: 'failure' })],
  })
  assert.equal(result.eligible, false)
})

test('concurrency supersession still promotes the newer verified main tip', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(mainSha), successfulRun(olderSha)],
  })
  assert.equal(result.sha, mainSha)
})

test('the actual workflow concurrency expression keeps eligible runs together and ignores others', () => {
  const manual = concurrencyGroup(githubEvent({ eventName: 'workflow_dispatch', runId: 1 }))
  const automatic = concurrencyGroup(githubEvent({ eventName: 'workflow_run', runId: 2, workflowRun: successfulRun() }))
  const ignored = [
    githubEvent({ eventName: 'workflow_run', runId: 3, workflowRun: successfulRun(olderSha, { conclusion: 'failure' }) }),
    githubEvent({ eventName: 'workflow_run', runId: 4, workflowRun: successfulRun(olderSha, { conclusion: 'cancelled' }) }),
    githubEvent({ eventName: 'workflow_dispatch', ref: 'refs/heads/release', runId: 5 }),
  ].map(concurrencyGroup)

  assert.equal(manual, 'deploy-production')
  assert.equal(automatic, 'deploy-production')
  assert.deepEqual(ignored, [
    'deploy-production-ignored-3',
    'deploy-production-ignored-4',
    'deploy-production-ignored-5',
  ])
})
