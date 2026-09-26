// Resolve the only SHA that production may build and promote. The workflow calls
// this while holding deploy-production, before any job receives package or SSH
// credentials. A successful CI event or a push to main is only a wake-up: what
// gets promoted is the newest commit on main that CI has verified.
//
// It used to be the tip or nothing, and that stalled production outright.
// Under merge traffic the tip moves again before its own CI finishes, so the
// gate never found a green tip and every deploy skipped while reporting
// success: on 2026-09-18 production sat on 628068308 from 07:58 while six
// later deploys went green having built and shipped nothing, and merged
// CI-verified commits waited hours. Walking back to the newest verified
// ancestor keeps the safety property exactly — the promoted SHA is still
// reachable from main and still verified by CI — and gives up only the
// pretence that production always runs the very tip. It never runs a commit
// main does not contain, and never one CI has not passed.
//
// A commit is verified in one of two ways. Its own successful trusted CI push
// run on main, as always; or — because most merges land exactly the tree a
// branch's CI already checked — a successful trusted CI push run on a branch
// whose head commit has the identical Git tree, whose production images were
// saved, and whose commit's first parent on main is itself verified. The tree
// ID names every byte of the content, so the branch run checked what main
// holds. Branch CI narrows its Turbo tasks to the packages that differ from
// main, so the parent condition is what vouches for everything else; and a
// commit whose own main run failed is never verified through a branch.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const DEPLOY_BRANCH = 'main'
export const CI_WORKFLOW_NAME = 'CI'
export const PRODUCTION_IMAGES = ['app', 'admin', 'web']

const sameRepository = (repository, expected) => repository?.full_name === expected

const trustedMainRun = (run, repository, sha) => (
  run?.event === 'push'
  && run.name === CI_WORKFLOW_NAME
  && run.head_branch === DEPLOY_BRANCH
  && run.head_sha === sha
  && sameRepository(run.repository, repository)
  && sameRepository(run.head_repository, repository)
)

const trustedSuccessfulMainRun = (run, repository, sha) => (
  run?.conclusion === 'success' && trustedMainRun(run, repository, sha)
)

const trustedSuccessfulBranchRun = (run, repository) => (
  run?.conclusion === 'success'
  && run.event === 'push'
  && run.name === CI_WORKFLOW_NAME
  && typeof run.head_branch === 'string'
  && run.head_branch !== DEPLOY_BRANCH
  && typeof run.head_commit?.tree_id === 'string'
  && sameRepository(run.repository, repository)
  && sameRepository(run.head_repository, repository)
)

const commitOf = (entry) => (typeof entry === 'string' ? { sha: entry } : entry)

/**
 * main's own history, newest first: the first-parent chain from the tip. The
 * commit list GitHub returns also holds every branch commit a merge brought
 * in; those were never main's state and must never be promoted. A list
 * without parent data is taken as given.
 */
function mainHistory(commits, tip) {
  if (!commits.some((commit) => Array.isArray(commit.parents))) return commits.map((commit) => commit.sha)
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const chain = []
  for (let sha = tip; sha && bySha.has(sha) && !chain.includes(sha); sha = bySha.get(sha).parents?.[0]) {
    chain.push(sha)
  }
  return chain
}

/**
 * Decide from already-read GitHub metadata so the policy is unit-testable.
 * A workflow_run payload never picks its own SHA: an older CI completion can
 * arrive after a newer one, and GitHub concurrency would otherwise discard the
 * newer pending deploy. The candidates are main's own commits, newest first,
 * and the first one CI has verified wins.
 *
 * `stalled` separates the two ways a run promotes nothing. A wake-up that was
 * never eligible to deploy — a failed CI, another branch, a foreign repository
 * — is ordinary and stays quiet. Getting past those checks and still finding
 * nothing verified anywhere on main is the silent-stall signature, and the
 * workflow fails the run on it rather than reporting another green no-op.
 *
 * `liveSha` is the commit the last successful deploy shipped. An automatic
 * wake-up does not ship it again, nor anything older: a tree-verified commit
 * goes out on its push, and its own CI completing later must not redeploy it.
 * A manual dispatch always ships.
 */
export function decideDeployGate({
  eventName,
  repository,
  ref,
  workflowRun,
  mainSha,
  mainCommits,
  workflowRuns,
  branchRuns = [],
  imageRunIds = [],
  liveSha,
}) {
  if (!repository || !mainSha) return { eligible: false, reason: 'missing repository or main SHA' }

  if (eventName === 'workflow_dispatch' || eventName === 'push') {
    if (ref !== `refs/heads/${DEPLOY_BRANCH}`) {
      return {
        eligible: false,
        reason: eventName === 'push' ? 'push is not to main' : 'manual dispatch is not from main',
      }
    }
  } else if (eventName === 'workflow_run') {
    if (!trustedSuccessfulMainRun(workflowRun, repository, workflowRun?.head_sha)) {
      return { eligible: false, reason: 'completed workflow run is not a trusted successful main CI push' }
    }
  } else {
    return { eligible: false, reason: `unsupported event ${eventName}` }
  }

  // Newest first. An empty or missing list degrades to the tip alone, which
  // is the old tip-or-nothing behaviour rather than a wider promotion.
  const commits = (mainCommits ?? []).map(commitOf)
  const history = commits.length ? mainHistory(commits, mainSha) : []
  const candidates = history.length ? history : [mainSha]
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  const withImages = new Set(imageRunIds.map(String))
  const memo = new Map()

  const verification = (sha) => {
    if (memo.has(sha)) return memo.get(sha)
    memo.set(sha, null)
    let result = null
    const own = workflowRuns.find((run) => trustedSuccessfulMainRun(run, repository, sha))
    if (own) {
      result = { ciRunId: own.id, sourceSha: sha, verifiedBy: 'own' }
    } else {
      const commit = bySha.get(sha)
      const parent = commit?.parents?.[0]
      const ownFailed = workflowRuns.some((run) => trustedMainRun(run, repository, sha) && run.conclusion === 'failure')
      const branchRun = commit?.tree && parent && !ownFailed
        ? branchRuns.find((run) => (
          trustedSuccessfulBranchRun(run, repository)
          && run.head_commit.tree_id === commit.tree
          && withImages.has(String(run.id))
        ))
        : undefined
      if (branchRun && verification(parent)) {
        result = {
          branch: branchRun.head_branch,
          ciRunId: branchRun.id,
          sourceSha: branchRun.head_sha,
          verifiedBy: 'tree',
        }
      }
    }
    memo.set(sha, result)
    return result
  }

  const behind = candidates.findIndex((sha) => verification(sha))

  if (behind === -1) {
    return {
      eligible: false,
      stalled: true,
      reason: 'no commit on main has a successful trusted CI push run',
    }
  }

  const sha = candidates[behind]
  if (eventName !== 'workflow_dispatch' && liveSha) {
    const live = candidates.indexOf(liveSha)
    if (live !== -1 && live <= behind) {
      return {
        eligible: false,
        reason: live === behind
          ? `${sha} is already live`
          : `production already runs ${liveSha}, newer than the newest verified commit ${sha}`,
      }
    }
  }

  const verified = verification(sha)
  const how = verified.verifiedBy === 'tree'
    ? ` (its tree passed CI on ${verified.branch} at ${verified.sourceSha}; that run's images are promoted)`
    : ''
  return {
    behind,
    ciRunId: verified.ciRunId,
    eligible: true,
    reason: (behind === 0
      ? `current main tip passed ${verified.verifiedBy === 'tree' ? 'trusted CI on an identical tree' : 'trusted CI'}`
      : `main tip has no successful trusted CI push run yet — promoting the newest verified ancestor, ${behind} commit(s) behind the tip`) + how,
    sha,
    sourceSha: verified.sourceSha,
    verifiedBy: verified.verifiedBy,
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

// The tree route and the already-live check only ever narrow what ships or
// add a verified candidate; if their lookups fail, the gate falls back to the
// own-run rule alone.
const optional = async (what, read, fallback) => {
  try {
    return await read()
  } catch (error) {
    console.error(`deploy gate: ${what} unavailable (${error.message}); continuing without it`)
    return fallback
  }
}

/** Runs that saved every production image, from the unexpired artifacts. */
const runsWithAllImages = async (repository) => {
  const perImage = await Promise.all(PRODUCTION_IMAGES.map(async (name) => {
    const { artifacts = [] } = await githubRequest(`/repos/${repository}/actions/artifacts?name=production-image-${name}&per_page=100`)
    return new Set(artifacts.filter((artifact) => !artifact.expired).map((artifact) => String(artifact.workflow_run?.id)))
  }))
  return [...perImage[0]].filter((id) => perImage.every((ids) => ids.has(id)))
}

/** The commit the newest successful deploy shipped, from its deploy job's name. */
const lastShippedSha = async (repository) => {
  const { workflow_runs: runs = [] } = await githubRequest(`/repos/${repository}/actions/workflows/deploy.yml/runs?status=success&per_page=10`)
  for (const run of runs) {
    const { jobs = [] } = await githubRequest(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=20`)
    const shipped = jobs.find((job) => job.conclusion === 'success' && /^Deploy [0-9a-f]{40} to Hetzner$/.test(job.name))
    if (shipped) return shipped.name.split(' ')[1]
  }
  return undefined
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
  const [branch, commits, runs, branchRuns, imageRunIds, liveSha] = await Promise.all([
    githubRequest(`/repos/${repository}/branches/${DEPLOY_BRANCH}`),
    githubRequest(`/repos/${repository}/commits?sha=${DEPLOY_BRANCH}&per_page=100`),
    githubRequest(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=${DEPLOY_BRANCH}&event=push&status=completed&per_page=100`),
    optional('branch CI runs', async () => (await githubRequest(`/repos/${repository}/actions/workflows/ci.yml/runs?event=push&status=success&per_page=100`)).workflow_runs ?? [], []),
    optional('production image artifacts', () => runsWithAllImages(repository), []),
    optional('the last shipped commit', () => lastShippedSha(repository), undefined),
  ])
  const decision = decideDeployGate({
    branchRuns,
    eventName,
    imageRunIds,
    liveSha,
    mainCommits: (Array.isArray(commits) ? commits : []).map((commit) => ({
      parents: (commit.parents ?? []).map((parent) => parent.sha),
      sha: commit.sha,
      tree: commit.commit?.tree?.sha,
    })),
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
    writeOutput('source_sha', decision.sourceSha)
    writeOutput('verified_by', decision.verifiedBy)
    writeOutput('ci_run_id', String(decision.ciRunId))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy gate failed: ${error.message}`)
    process.exitCode = 1
  })
}
