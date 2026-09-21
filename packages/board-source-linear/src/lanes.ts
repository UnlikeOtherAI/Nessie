import type { ConnectionContext, SyncCheckpoint, SyncPage } from '@nessie/board-sources'

import { type LinearComment, type LinearIssue, normaliseLinearComment, normaliseLinearIssue } from './normalise.js'
import { COMMENTS_PAGE_QUERY, ISSUES_PAGE_QUERY } from './queries.js'

/**
 * The two lanes `fetchPage` walks over one checkpoint: issues, then the team's
 * comments on their own clock. Separate from the adapter object because the
 * state machine is the part worth reading on its own.
 */

export type LinearGraphQl = <T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>

/** Where the initial comment walk starts when the lane has no clock of its own yet. */
const COMMENTS_EPOCH = '1970-01-01T00:00:00.000Z'

/** A one-minute overlap: Linear orders by `updatedAt` and the boundary second must not fall between two syncs. */
const overlapFrom = (latest: string | null, fallback: string): string =>
  latest ? new Date(Date.parse(latest) - 60_000).toISOString() : fallback

const newestUpdatedAt = (rows: readonly { updatedAt: string }[]): string | null =>
  rows.reduce<string | null>(
    (newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest),
    null,
  )

export const fetchIssuesLane = async (
  gql: LinearGraphQl,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  checkpoint: SyncCheckpoint,
  options: { syncWindowDays: number },
): Promise<SyncPage> => {
  const teamId = String(container.teamId ?? '')
  // The first sync is bounded by the window; every later one resumes from the
  // last item's `updatedAt`, minus an overlap so an item updated during the
  // page boundary is not skipped.
  const since =
    checkpoint.since ??
    new Date(Date.now() - options.syncWindowDays * 24 * 60 * 60 * 1000).toISOString()

  const data = await gql<{
    issues: {
      nodes: LinearIssue[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }>(ctx.credential.accessToken, ISSUES_PAGE_QUERY, {
    teamId,
    updatedAfter: since,
    ...(checkpoint.cursor ? { after: checkpoint.cursor } : {}),
  })

  const items = data.issues.nodes.map(normaliseLinearIssue)
  const commentClock = checkpoint.commentsSince ? { commentsSince: checkpoint.commentsSince } : {}
  if (data.issues.pageInfo.hasNextPage) {
    return {
      items,
      hasMore: true,
      checkpoint: {
        phase: checkpoint.phase,
        since,
        lane: 'items',
        ...commentClock,
        ...(data.issues.pageInfo.endCursor ? { cursor: data.issues.pageInfo.endCursor } : {}),
      },
    }
  }
  // The issues are current. Hand over to the comment lane, on its own clock —
  // from the epoch when it has none yet, so the first run (and the first run
  // after this lane existed) brings every comment the mirrored issues have.
  return {
    items,
    hasMore: true,
    checkpoint: {
      phase: 'incremental',
      since: overlapFrom(newestUpdatedAt(items), since),
      lane: 'comments',
      commentsSince: checkpoint.commentsSince ?? COMMENTS_EPOCH,
    },
  }
}

export const fetchCommentsLane = async (
  gql: LinearGraphQl,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  checkpoint: SyncCheckpoint,
): Promise<SyncPage> => {
  const teamId = String(container.teamId ?? '')
  const commentsSince = checkpoint.commentsSince ?? COMMENTS_EPOCH
  const data = await gql<{
    comments: {
      nodes: LinearComment[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }>(ctx.credential.accessToken, COMMENTS_PAGE_QUERY, {
    teamId,
    updatedAfter: commentsSince,
    ...(checkpoint.commentsCursor ? { after: checkpoint.commentsCursor } : {}),
  })
  const comments = data.comments.nodes.map((comment) => normaliseLinearComment(comment))
  const base = {
    phase: checkpoint.phase,
    ...(checkpoint.since ? { since: checkpoint.since } : {}),
  }
  if (data.comments.pageInfo.hasNextPage) {
    return {
      items: [],
      comments,
      hasMore: true,
      checkpoint: {
        ...base,
        lane: 'comments',
        commentsSince,
        ...(data.comments.pageInfo.endCursor
          ? { commentsCursor: data.comments.pageInfo.endCursor }
          : {}),
      },
    }
  }
  // Last comment page: back to the item lane for the next run, both clocks
  // advanced. `hasMore: false` ends this run.
  return {
    items: [],
    comments,
    hasMore: false,
    checkpoint: {
      ...base,
      lane: 'items',
      commentsSince: overlapFrom(newestUpdatedAt(comments), commentsSince),
    },
  }
}

