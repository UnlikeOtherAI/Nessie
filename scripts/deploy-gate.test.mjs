import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseDocument } from 'yaml'
import { CI_WORKFLOW_NAME, decideDeployGate } from './deploy-gate.mjs'

const repository = 'UnlikeOtherAI/Nessie'
const olderSha = '1'.repeat(40)
const mainSha = '2'.repeat(40)
const middleSha = '3'.repeat(40)
const foreignSha = '4'.repeat(40)

// main, newest first: the tip, one commit under it, then the oldest.
const mainCommits = [mainSha, middleSha, olderSha]

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
  mainCommits,
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
    behind: 0,
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

// This is the behaviour change. It used to assert `eligible: false` — the tip
// or nothing — and that is exactly what froze production on 2026-09-18: the
// tip's CI was still running, so every deploy declined and shipped nothing for
// hours while reporting success. Falling back to the newest verified ancestor
// is the fix, and it gives up no safety: that commit is on main and has its
// own green trusted CI push run.
test('promotes the newest verified ancestor while the tip CI is still running', () => {
  const result = decide({
    workflowRun: successfulRun(middleSha),
    workflowRuns: [successfulRun(middleSha)],
  })
  assert.deepEqual(result, {
    behind: 1,
    eligible: true,
    reason: 'main tip has no successful trusted CI push run yet — promoting the newest verified ancestor, 1 commit(s) behind the tip',
    sha: middleSha,
  })
})

test('a failed tip does not block the last good commit from shipping', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(olderSha), successfulRun(mainSha, { conclusion: 'failure' })],
  })
  assert.equal(result.sha, olderSha)
  assert.equal(result.behind, 2)
})

test('promotes the NEWEST verified ancestor, not merely a verified one', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(olderSha), successfulRun(middleSha)],
  })
  assert.equal(result.sha, middleSha)
})

test('never promotes a verified commit that is not on main', () => {
  const result = decide({
    workflowRun: successfulRun(foreignSha),
    workflowRuns: [successfulRun(foreignSha)],
  })
  assert.deepEqual(result, {
    eligible: false,
    reason: 'no commit on main has a successful trusted CI push run',
    stalled: true,
  })
})

test('an unreadable commit list degrades to the tip alone, never wider', () => {
  for (const commits of [[], undefined]) {
    assert.equal(decide({ mainCommits: commits }).sha, mainSha)
    assert.equal(
      decide({
        mainCommits: commits,
        workflowRun: successfulRun(middleSha),
        workflowRuns: [successfulRun(middleSha)],
      }).eligible,
      false,
    )
  }
})

// The two ways a run promotes nothing must not read alike: an ineligible
// wake-up is ordinary, a stall is the alarm the workflow fails the run on.
test('only a stall is flagged, never an ordinary ineligible wake-up', () => {
  const stall = decide({ workflowRuns: [] })
  assert.equal(stall.stalled, true)

  for (const ineligible of [
    decide({ workflowRun: successfulRun(mainSha, { conclusion: 'failure' }) }),
    decide({ workflowRun: successfulRun(mainSha, { head_branch: 'feature' }) }),
    decide({ eventName: 'workflow_dispatch', ref: 'refs/heads/release', workflowRun: undefined }),
  ]) {
    assert.equal(ineligible.eligible, false)
    assert.equal(ineligible.stalled, undefined)
  }
})

test('concurrency supersession still promotes the newer verified main tip', () => {
  const result = decide({
    workflowRun: successfulRun(olderSha),
    workflowRuns: [successfulRun(mainSha), successfulRun(olderSha)],
  })
  assert.equal(result.sha, mainSha)
})

// A policy that reports a stall is worth nothing if the YAML does not act on
// it: the whole defect was a Deploy run that promoted nothing and still went
// green, so the wiring is asserted against the deployed workflow itself.
test('the workflow fails the run on a stall and publishes the decision', () => {
  const gate = workflow.get('jobs').get('gate')
  const outputs = gate.get('outputs')
  for (const key of ['behind', 'eligible', 'reason', 'sha', 'stalled']) {
    assert.ok(outputs.get(key), `the gate job must expose the '${key}' output`)
  }

  const steps = gate.get('steps').toJSON()
  const failing = steps.find((step) => String(step.if ?? '').includes("steps.resolve.outputs.stalled == 'true'"))
  assert.ok(failing, 'a step must be conditioned on the gate reporting a stall')
  assert.match(failing.run, /exit 1/, 'a stall must fail the run, not report success')

  const summary = steps.find((step) => String(step.run ?? '').includes('GITHUB_STEP_SUMMARY'))
  assert.ok(summary, 'the gate must write its decision to the run summary')
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
