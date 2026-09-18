// Resolve the only SHA that production may build and promote. The workflow calls
// this while holding deploy-production, before any job receives package or SSH
// credentials. A successful CI event is only a wake-up: what gets promoted is
// the newest commit on main that is itself the exact SHA of a successful
// trusted CI push run.
//
// It used to be the tip or nothing, and that stalled production outright.
// Under merge traffic the tip moves again before its own CI finishes, so the
// gate never found a green tip and every deploy skipped while reporting
// success: on 2026-09-18 production sat on 628068308 from 07:58 while six
// later deploys went green having built and shipped nothing, and merged
// CI-verified commits waited hours. Walking back to the newest verified
// ancestor keeps the safety property exactly — the promoted SHA is still
// reachable from main and still has its own green trusted CI push run — and
// gives up only the pretence that production always runs the very tip. It
// never runs a commit main does not contain, and never one CI has not passed.
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
 * newer pending deploy. The candidates are main's own commits, newest first,
 * and the first one carrying a successful trusted CI push run wins.
 *
 * `stalled` separates the two ways a run promotes nothing. A wake-up that was
 * never eligible to deploy — a failed CI, another branch, a foreign repository
 * — is ordinary and stays quiet. Getting past those checks and still finding
 * nothing verified anywhere on main is the silent-stall signature, and the
 * workflow fails the run on it rather than reporting another green no-op.
 */
export function decideDeployGate({ eventName, repository, ref, workflowRun, mainSha, mainCommits, workflowRuns }) {
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

  // Newest first, and every entry is reachable from the tip by construction —
  // the caller reads them from main's own commit list. An empty or missing
  // list degrades to the tip alone, which is the old tip-or-nothing behaviour
  // rather than a wider promotion.
  const candidates = mainCommits?.length ? mainCommits : [mainSha]
  const behind = candidates.findIndex(
    (sha) => workflowRuns.some((run) => trustedSuccessfulMainRun(run, repository, sha)),
  )

  if (behind === -1) {
    return {
      eligible: false,
      stalled: true,
      reason: 'no commit on main has a successful trusted CI push run',
    }
  }

  return {
    behind,
    eligible: true,
    reason: behind === 0
      ? 'current main tip passed trusted CI'
      : `main tip has no successful trusted CI push run yet — promoting the newest verified ancestor, ${behind} commit(s) behind the tip`,
    sha: candidates[behind],
  }
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
  // The commit page bounds how far back a promotion may reach: one page of
  // main's history against one page of completed CI runs. A verified commit
  // older than either page is not promoted — production waits for the next
  // green CI rather than reaching into the distant past.
  const [branch, commits, runs] = await Promise.all([
    githubRequest(`/repos/${repository}/branches/${DEPLOY_BRANCH}`),
    githubRequest(`/repos/${repository}/commits?sha=${DEPLOY_BRANCH}&per_page=100`),
    githubRequest(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=${DEPLOY_BRANCH}&event=push&status=completed&per_page=100`),
  ])
  const decision = decideDeployGate({
    eventName,
    mainCommits: (Array.isArray(commits) ? commits : []).map((commit) => commit.sha),
    mainSha: branch.commit?.sha,
    ref,
    repository,
    workflowRun: event.workflow_run,
    workflowRuns: runs.workflow_runs ?? [],
  })

  console.error(`deploy gate: ${decision.reason}`)
  writeOutput('eligible', String(decision.eligible))
  writeOutput('reason', decision.reason)
  writeOutput('stalled', String(decision.stalled === true))
  if (decision.eligible) {
    writeOutput('behind', String(decision.behind))
    writeOutput('sha', decision.sha)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy gate failed: ${error.message}`)
    process.exitCode = 1
  })
}
