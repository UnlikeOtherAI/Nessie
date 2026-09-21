import type {
  ConnectionContext,
  NormalisedComment,
  SyncCheckpoint,
  SyncPage,
} from '@nessie/board-sources'

import {
  GITHUB_ALLOWED_HOSTS,
  type GitHubTransport,
  graphqlPayload,
  repoApi,
  repoOf,
  restHeaders,
} from './http.js'
import {
  type GitHubComment,
  type GitHubIssue,
  issueNumberOf,
  normaliseGitHubComment,
  normaliseGitHubIssue,
} from './normalise.js'

/**
 * The two lanes a repository source's `fetchPage` walks over one checkpoint:
 * issues, then the repository's issue comments, flat, on their own clock —
 * Linear's state machine, over GitHub's REST pages.
 */

export const GITHUB_ISSUE_PAGE_SIZE = 100
/**
 * Half the issue page: a comment body may be 64 KiB, and the envelope's 1 MiB
 * response cap would otherwise stall the lane on the same page forever.
 */
export const GITHUB_COMMENT_PAGE_SIZE = 50

/** Where the initial comment walk starts: every comment the mirrored issues have. */
const COMMENTS_EPOCH = '1970-01-01T00:00:00.000Z'

/** GitHub orders by `updated_at`; a minute of overlap keeps the boundary second. */
const overlapFrom = (latest: string | null, fallback: string): string =>
  latest ? new Date(Date.parse(latest) - 60_000).toISOString() : fallback

const newest = (values: readonly string[]): string | null =>
  values.reduce<string | null>((max, value) => (max === null || value > max ? value : max), null)

export const fetchIssuesLane = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  checkpoint: SyncCheckpoint,
  options: { syncWindowDays: number },
): Promise<SyncPage> => {
  const since =
    checkpoint.since ??
    new Date(Date.now() - options.syncWindowDays * 24 * 60 * 60 * 1000).toISOString()
  const page = Number(checkpoint.cursor ?? '1')
  const url = new URL(`${repoApi(container)}/issues`)
  url.searchParams.set('state', 'all')
  url.searchParams.set('since', since)
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('direction', 'asc')
  url.searchParams.set('per_page', String(GITHUB_ISSUE_PAGE_SIZE))
  url.searchParams.set('page', String(page))

  const rows = await http.json<GitHubIssue[]>({
    url: url.toString(),
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: restHeaders(ctx),
  })
  // The issues endpoint returns pull requests too; they are not board work.
  const items = rows.filter((row) => !row.pull_request).map((row) => normaliseGitHubIssue(row))
  const commentClock = checkpoint.commentsSince ? { commentsSince: checkpoint.commentsSince } : {}
  if (rows.length === GITHUB_ISSUE_PAGE_SIZE) {
    return {
      items,
      hasMore: true,
      checkpoint: {
        phase: checkpoint.phase,
        since,
        lane: 'items',
        cursor: String(page + 1),
        ...commentClock,
      },
    }
  }
  // Issues are current: hand over to the comment lane on its own clock, from
  // the epoch when it has none yet, so the first run brings every comment.
  return {
    items,
    hasMore: true,
    checkpoint: {
      phase: 'incremental',
      since: overlapFrom(newest(items.map((item) => item.updatedAt)), since),
      lane: 'comments',
      commentsSince: checkpoint.commentsSince ?? COMMENTS_EPOCH,
    },
  }
}

/**
 * A GitHub comment names its issue by number (`issue_url`), and the mirror
 * keys issues by `node_id`. One aliased GraphQL read resolves a page's numbers
 * at once; a number that is a pull request, or no longer resolves (a deleted
 * or transferred issue), is simply absent from the answer — its comments are
 * dropped, exactly as a comment on an unmirrored issue would be.
 */
export const resolveIssueNodeIds = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  numbers: readonly number[],
): Promise<Map<number, string>> => {
  const unique = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0)
  if (unique.length === 0) return new Map()
  const { owner, repo } = repoOf(container)
  const selections = unique
    .map((n) => `i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { id } }`)
    .join('\n')
  const payload = await graphqlPayload<{
    repository: Record<string, { __typename?: string; id?: string } | null> | null
  }>(
    http,
    ctx,
    `query IssueNodeIds($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${selections} } }`,
    { owner, name: repo },
  )
  // A partial answer is the normal case when one number is gone; only an
  // answer with no repository at all is a failure of the page.
  const repository = payload.data?.repository
  if (!repository) {
    throw new Error(payload.errors?.[0]?.message ?? 'GitHub could not resolve the issues')
  }
  const resolved = new Map<number, string>()
  for (const n of unique) {
    const node = repository[`i${n}`]
    if (node?.__typename === 'Issue' && node.id) resolved.set(n, node.id)
  }
  return resolved
}

export const fetchCommentsLane = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  checkpoint: SyncCheckpoint,
): Promise<SyncPage> => {
  const commentsSince = checkpoint.commentsSince ?? COMMENTS_EPOCH
  const page = Number(checkpoint.commentsCursor ?? '1')
  const url = new URL(`${repoApi(container)}/issues/comments`)
  url.searchParams.set('since', commentsSince)
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('direction', 'asc')
  url.searchParams.set('per_page', String(GITHUB_COMMENT_PAGE_SIZE))
  url.searchParams.set('page', String(page))

  const rows = await http.json<GitHubComment[]>({
    url: url.toString(),
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: restHeaders(ctx),
  })
  const nodeIds = await resolveIssueNodeIds(
    http,
    ctx,
    container,
    rows.flatMap((row) => issueNumberOf(row) ?? []),
  )
  const comments: NormalisedComment[] = rows.flatMap((row) => {
    const number = issueNumberOf(row)
    const issueExternalId = number === null ? undefined : nodeIds.get(number)
    return issueExternalId ? [normaliseGitHubComment(row, issueExternalId)] : []
  })
  const base = { phase: checkpoint.phase, ...(checkpoint.since ? { since: checkpoint.since } : {}) }

  if (rows.length === GITHUB_COMMENT_PAGE_SIZE) {
    return {
      items: [],
      comments,
      hasMore: true,
      checkpoint: { ...base, lane: 'comments', commentsSince, commentsCursor: String(page + 1) },
    }
  }
  // Last page: back to the item lane for the next run, both clocks advanced.
  // The clock follows every row read, pull-request comments included, so a
  // quiet repository with busy PRs still moves forward.
  return {
    items: [],
    comments,
    hasMore: false,
    checkpoint: {
      ...base,
      lane: 'items',
      commentsSince: overlapFrom(newest(rows.map((row) => row.updated_at)), commentsSince),
    },
  }
}

/**
 * One issue's comments, for the webhook path's re-read. Paged to a bound: a
 * thread longer than that still has its newest comments arrive on the lane.
 */
export const GITHUB_ISSUE_COMMENT_PAGES = 10

export const fetchIssueComments = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  issueNumber: number,
): Promise<GitHubComment[]> => {
  const all: GitHubComment[] = []
  for (let page = 1; page <= GITHUB_ISSUE_COMMENT_PAGES; page += 1) {
    const rows = await http.json<GitHubComment[]>({
      url: `${repoApi(container)}/issues/${issueNumber}/comments?per_page=${GITHUB_COMMENT_PAGE_SIZE}&page=${page}`,
      allowedHosts: GITHUB_ALLOWED_HOSTS,
      headers: restHeaders(ctx),
    })
    all.push(...rows)
    if (rows.length < GITHUB_COMMENT_PAGE_SIZE) break
  }
  return all
}
