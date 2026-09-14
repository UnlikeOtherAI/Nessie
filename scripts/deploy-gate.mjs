// Resolve the only SHA that production may build and promote. The workflow calls
// this while holding deploy-production, before any job receives package or SSH
// credentials. A successful CI event is only a wake-up: the current main tip
// must itself be the exact SHA of a successful trusted CI push run.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const DEPLOY_BRANCH = 'main'
export const CI_WORKFLOW_NAME = 'CI'

const sameRepository = (repository, expected) => repository?.full_name === expected

const trustedSuccessfulMainRun = (run, repository, sha) => (
  run?.conclusion === 'success'
  && run.event === 'push'
  && run.name === CI_WORKFLOW_NAME
  && run.head_branch === DEPLOY_BRANCH
  && run.head_sha === sha
  && sameRepository(run.repository, repository)
  && sameRepository(run.head_repository, repository)
)

/**
 * Decide from already-read GitHub metadata so the policy is unit-testable.
 * A workflow_run payload never picks its own SHA: an older CI completion can
 * arrive after a newer one, and GitHub concurrency would otherwise discard the
 * newer pending deploy. Only a verified current main tip is eligible.
 */
export function decideDeployGate({ eventName, repository, ref, workflowRun, mainSha, workflowRuns }) {
  if (!repository || !mainSha) return { eligible: false, reason: 'missing repository or main SHA' }

  if (eventName === 'workflow_dispatch') {
    if (ref !== `refs/heads/${DEPLOY_BRANCH}`) {
      return { eligible: false, reason: 'manual dispatch is not from main' }
    }
  } else if (eventName === 'workflow_run') {
    if (!trustedSuccessfulMainRun(workflowRun, repository, workflowRun?.head_sha)) {
      return { eligible: false, reason: 'completed workflow run is not a trusted successful main CI push' }
    }
  } else {
    return { eligible: false, reason: `unsupported event ${eventName}` }
  }

  if (!workflowRuns.some((run) => trustedSuccessfulMainRun(run, repository, mainSha))) {
    return { eligible: false, reason: 'current main tip has no successful trusted CI push run' }
  }

  return { eligible: true, reason: 'current main tip passed trusted CI', sha: mainSha }
}

const githubRequest = async (path) => {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required to resolve the deploy gate')
  const response = await fetch(`${api}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`)
  return response.json()
}

const writeOutput = (key, value) => {
  process.stdout.write(`${key}=${value}\n`)
}

const main = async () => {
  const eventName = process.env.DEPLOY_EVENT_NAME
  const repository = process.env.DEPLOY_REPOSITORY
  const ref = process.env.DEPLOY_REF
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventName || !repository || !ref || !eventPath) {
    throw new Error('DEPLOY_EVENT_NAME, DEPLOY_REPOSITORY, DEPLOY_REF, and GITHUB_EVENT_PATH are required')
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'))
  const [branch, runs] = await Promise.all([
    githubRequest(`/repos/${repository}/branches/${DEPLOY_BRANCH}`),
    githubRequest(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=${DEPLOY_BRANCH}&event=push&status=completed&per_page=100`),
  ])
  const decision = decideDeployGate({
    eventName,
    mainSha: branch.commit?.sha,
    ref,
    repository,
    workflowRun: event.workflow_run,
    workflowRuns: runs.workflow_runs ?? [],
  })

  console.error(`deploy gate: ${decision.reason}`)
  writeOutput('eligible', String(decision.eligible))
  writeOutput('reason', decision.reason)
  if (decision.eligible) writeOutput('sha', decision.sha)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy gate failed: ${error.message}`)
    process.exitCode = 1
  })
}
