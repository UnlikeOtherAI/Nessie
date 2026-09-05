import { createHash } from 'node:crypto'

/**
 * The provider-agnostic shape every adapter normalises an external item into,
 * and the fingerprint echo suppression compares.
 */

export type NormalisedItemLabel = { id: string; label: string }

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
}

export type SyncCheckpoint = {
  cursor?: string
  /** ISO timestamp the next incremental page starts from. */
  since?: string
  phase: 'initial' | 'incremental'
}

export type SyncPage = {
  items: NormalisedItem[]
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
