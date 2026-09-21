import { createHash } from 'node:crypto'

/**
 * The provider-agnostic shape every adapter normalises an external item into,
 * and the fingerprint echo suppression compares.
 */

/**
 * A provider label. `color` is `#rrggbb` where the provider has one; the
 * adapter maps a named colour (Trello) to hex itself.
 */
export type NormalisedItemLabel = { id: string; label: string; color?: string }

export type NormalisedItemAssignee = {
  externalUserId: string
  displayName: string
  email?: string
}

export type NormalisedItem = {
  externalId: string
  externalKey: string
  url: string
  title: string
  description: string | null
  stateId: string
  stateName: string
  assignee: NormalisedItemAssignee | null
  /** The provider's own priority token; the source's mapping turns it into ours. */
  priority: string | null
  /** `YYYY-MM-DD`. */
  dueDate: string | null
  labels: NormalisedItemLabel[]
  /** Everything else the adapter read, keyed by the provider's field key. */
  fields: Record<string, unknown>
  createdAt: string
  updatedAt: string
  /** Deleted, trashed or cancelled upstream. */
  archived: boolean
  /**
   * The item's comments, when this call read them. `undefined` means "not read
   * on this call, leave what is stored" — never "there are none".
   */
  comments?: NormalisedComment[]
  /** The item's files and links (and inline assets), when this call read them. */
  attachments?: NormalisedAttachment[]
}

/** One upstream comment on an item, normalised. */
export type NormalisedComment = {
  externalId: string
  issueExternalId: string
  /** Markdown. */
  body: string
  /** `null` = a bot or an unknown actor; see `authorDisplay`. */
  author: NormalisedItemAssignee | null
  /** What to show when `author` is null (a bot actor's name). */
  authorDisplay?: string | null
  createdAt: string
  updatedAt: string
  editedAt?: string | null
  url?: string | null
  parentExternalId?: string | null
  /** Narrower audience than the issue (Jira `visibility`). Never imported. */
  restricted?: boolean
}

/** One upstream file or link on an item, or an asset found inside its text. */
export type NormalisedAttachment = {
  /** The provider's id, where it has one. */
  externalId?: string
  issueExternalId: string
  /** Set when the file hangs off a comment. */
  commentExternalId?: string
  /** The idempotency key, with the source: `(sourceId, url)`. */
  url: string
  title: string | null
  contentType?: string | null
  sizeBytes?: number | null
  /** `file`: bytes `fetchAsset` can read; `link`: a URL that is the whole attachment. */
  kind: 'file' | 'link'
  /** Found inside the description or a comment body, not on the item's attachment list. */
  inline?: boolean
  createdAt: string
}

/** What a write-back asks the vendor to change. */
export type OutboundChange = {
  stateId?: string
  title?: string
  description?: string | null
  assigneeExternalUserId?: string | null
  priority?: string | null
  dueDate?: string | null
  fields?: Record<string, unknown>
  /** Provider label ids — the whole set the item should carry. */
  labelIds?: string[]
}

export type SyncCheckpoint = {
  cursor?: string
  /** ISO timestamp the next incremental page starts from. */
  since?: string
  phase: 'initial' | 'incremental'
  /** The incremental comment lane: after the item pages, the comment pages. */
  lane?: 'items' | 'comments'
  commentsCursor?: string
  commentsSince?: string
}

export type SyncPage = {
  items: NormalisedItem[]
  /** Comments that changed independently of their item (the comment lane). */
  comments?: NormalisedComment[]
  checkpoint: SyncCheckpoint
  hasMore: boolean
}

/**
 * A stable hash of only the fields a source actually maps, in a fixed order.
 *
 * This is what makes echo suppression exact rather than heuristic: after a
 * write-back the vendor's echo hashes to the value stored as
 * `outboundFingerprint`, so the webhook it triggers is recognised as our own
 * and writes no event. Unmapped fields are excluded deliberately — a change to
 * one of them is not a change this board can see, so it must not look like one.
 */
export const itemFingerprint = (
  item: NormalisedItem,
  mappedFieldKeys: readonly string[],
): string => {
  const mapped: Record<string, unknown> = {}
  for (const key of [...mappedFieldKeys].sort()) {
    mapped[key] = item.fields[key] ?? null
  }
  const canonical = JSON.stringify([
    item.externalId,
    item.title,
    item.description ?? null,
    item.stateId,
    item.assignee?.externalUserId ?? null,
    item.priority ?? null,
    item.dueDate ?? null,
    item.labels.map((label) => label.id).sort(),
    mapped,
    item.archived,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}
