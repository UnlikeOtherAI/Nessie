import type { SyncCheckpoint, SyncPage } from '@nessie/board-sources'

import {
  ATTACHMENT_FIELDS,
  CARD_FIELDS,
  TRELLO_ALLOWED_HOSTS,
  TRELLO_API_HOST,
  type TrelloTransport,
} from './http.js'
import {
  type TrelloCard,
  type TrelloCommentAction,
  type TrelloList,
  normaliseTrelloCard,
  normaliseTrelloComment,
} from './normalise.js'

/**
 * The two lanes a Trello source's `fetchPage` walks over one checkpoint: the
 * whole board's cards (Trello has no `since` on cards), then the board's
 * `commentCard` actions, flat, on their own clock.
 */

/**
 * A comment may be 16 KiB, and the envelope caps a response at 1 MiB; a page
 * that could exceed it would stall the lane on the same page forever.
 */
export const TRELLO_COMMENT_PAGE_SIZE = 50

const COMMENTS_EPOCH = '1970-01-01T00:00:00.000Z'

export type TrelloLaneDeps = {
  http: TrelloTransport
  /** `key=…&token=…` for this connection. */
  auth: string
  boardId: string
}

export const fetchCardsLane = async (
  deps: TrelloLaneDeps,
  lists: TrelloList[],
  checkpoint: SyncCheckpoint,
): Promise<SyncPage> => {
  const listNames = new Map(lists.map((list) => [list.id, list.name]))
  const cards = await deps.http.json<TrelloCard[]>({
    url:
      `https://${TRELLO_API_HOST}/1/boards/${deps.boardId}/cards/all?fields=${CARD_FIELDS}` +
      `&attachments=true&attachment_fields=${ATTACHMENT_FIELDS}&${deps.auth}`,
    allowedHosts: TRELLO_ALLOWED_HOSTS,
  })

  // No `since` on cards: the whole board is read and the checkpoint is used to
  // skip what has not moved since the last pass.
  const since = checkpoint.since
  const items = cards
    .map((card) => normaliseTrelloCard(card, listNames))
    .filter((item) => !since || item.updatedAt > since)

  // The cards are current; hand over to the comment lane. `since` is stamped
  // now, before the walk, and is where the comment clock moves to when the
  // walk ends — so a comment written mid-walk is read again, not missed.
  return {
    items,
    hasMore: true,
    checkpoint: {
      phase: 'incremental',
      since: new Date().toISOString(),
      lane: 'comments',
      commentsSince: checkpoint.commentsSince ?? COMMENTS_EPOCH,
    },
  }
}

/**
 * Trello answers actions newest first and pages backwards with `before`. The
 * lane's lower bound is `commentsSince`; when the walk reaches it the clock
 * moves to the moment the card lane ran, less a minute of overlap.
 *
 * `since` bounds an action by when it was *written*: an edit to an old
 * comment is not seen here, only through the webhook's `updateComment`, which
 * re-reads the card with its comments.
 */
export const fetchCommentsLane = async (
  deps: TrelloLaneDeps,
  checkpoint: SyncCheckpoint,
): Promise<SyncPage> => {
  const commentsSince = checkpoint.commentsSince ?? COMMENTS_EPOCH
  const url = new URL(`https://${TRELLO_API_HOST}/1/boards/${deps.boardId}/actions`)
  url.searchParams.set('filter', 'commentCard')
  url.searchParams.set('limit', String(TRELLO_COMMENT_PAGE_SIZE))
  url.searchParams.set('since', commentsSince)
  url.searchParams.set('memberCreator_fields', 'fullName,username')
  if (checkpoint.commentsCursor) url.searchParams.set('before', checkpoint.commentsCursor)

  const actions = await deps.http.json<TrelloCommentAction[]>({
    url: `${url.toString()}&${deps.auth}`,
    allowedHosts: TRELLO_ALLOWED_HOSTS,
  })
  const comments = actions.map((action) => normaliseTrelloComment(action))
  const base = { phase: checkpoint.phase, ...(checkpoint.since ? { since: checkpoint.since } : {}) }
  const oldest = actions.at(-1)

  if (actions.length === TRELLO_COMMENT_PAGE_SIZE && oldest) {
    return {
      items: [],
      comments,
      hasMore: true,
      checkpoint: { ...base, lane: 'comments', commentsSince, commentsCursor: oldest.id },
    }
  }
  const walkedTo = checkpoint.since
    ? new Date(Date.parse(checkpoint.since) - 60_000).toISOString()
    : commentsSince
  return {
    items: [],
    comments,
    hasMore: false,
    checkpoint: { ...base, lane: 'items', commentsSince: walkedTo },
  }
}
