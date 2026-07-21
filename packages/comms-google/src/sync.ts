import type {
  ConnectorConnectionContext,
  NormalizedEvent,
  SyncCheckpoint,
  SyncResult,
} from '@nessie/comms-connect'

import type { GmailClient, GmailMessageRef } from './client.js'
import {
  decodeHistoryCursor,
  decodeIncrementalCursor,
  encodeCursor,
  nowMs,
  resolvePageSize,
  type GoogleConnectorDeps,
  type HistoryCursor,
  type IncrementalCursor,
} from './config.js'
import { GmailHistoryExpiredError } from './errors.js'
import { normalizeGmailDeletion, normalizeGmailMessage } from './normalize.js'

const minIso = (a: string | undefined, b: string): string =>
  a === undefined || b < a ? b : a

const maxIso = (a: string | undefined, b: string): string =>
  a === undefined || b > a ? b : a

const boundsOf = (
  events: readonly NormalizedEvent[],
  base: SyncCheckpoint,
): Pick<SyncCheckpoint, 'oldestImportedAt' | 'newestImportedAt'> => {
  let oldest = base.oldestImportedAt
  let newest = base.newestImportedAt
  for (const event of events) {
    oldest = minIso(oldest, event.occurredAt)
    newest = maxIso(newest, event.occurredAt)
  }
  return { oldestImportedAt: oldest, newestImportedAt: newest }
}

/**
 * One page of the initial history back-fill. Lists message ids in the chosen
 * window (`after:` from the cursor/deps), fetches each in full, normalizes, and
 * returns a resumable checkpoint. The mailbox `historyId` baseline is captured
 * on the first page so a later reconciliation has a starting point.
 */
export const runGmailInitialSync = async (
  client: GmailClient,
  deps: GoogleConnectorDeps,
  connection: ConnectorConnectionContext,
  checkpoint?: SyncCheckpoint,
): Promise<SyncResult> => {
  const access = connection.credential.accessToken
  const emailAddress = connection.externalTenantId
  const cursor = decodeHistoryCursor(checkpoint?.cursor)
  const after = cursor.after ?? deps.initialAfterEpochSec

  let historyId = cursor.historyId
  if (historyId === undefined) {
    historyId = (await client.getProfile(access)).historyId
  }

  const q = after !== undefined ? `after:${after}` : undefined
  const list = await client.listMessages(access, {
    q,
    pageToken: cursor.pageToken,
    maxResults: resolvePageSize(deps),
  })

  const events: NormalizedEvent[] = []
  for (const ref of list.messages ?? []) {
    const message = await client.getMessage(access, ref.id)
    events.push(normalizeGmailMessage(emailAddress, message))
  }

  const nextCursor: HistoryCursor = {
    after,
    historyId,
    pageToken: list.nextPageToken,
  }
  return {
    events,
    checkpoint: {
      cursor: encodeCursor(nextCursor),
      ...boundsOf(events, checkpoint ?? {}),
    },
    hasMore: Boolean(list.nextPageToken),
  }
}

const collectHistoryEvents = async (
  client: GmailClient,
  access: string,
  emailAddress: string,
  deletionAt: string,
  records: NonNullable<Awaited<ReturnType<GmailClient['listHistory']>>>['history'],
): Promise<NormalizedEvent[]> => {
  const events: NormalizedEvent[] = []
  const seenAdded = new Set<string>()
  for (const record of records ?? []) {
    for (const added of record.messagesAdded ?? []) {
      const ref = added.message
      if (ref && !seenAdded.has(ref.id)) {
        seenAdded.add(ref.id)
        const message = await client.getMessage(access, ref.id)
        events.push(normalizeGmailMessage(emailAddress, message))
      }
    }
    for (const deleted of record.messagesDeleted ?? []) {
      const ref: GmailMessageRef | undefined = deleted.message
      if (ref) {
        events.push(
          normalizeGmailDeletion(
            emailAddress,
            { threadId: ref.threadId, messageId: ref.id },
            deletionAt,
          ),
        )
      }
    }
  }
  return events
}

/**
 * One page of incremental sync. On the very first run (no stored `historyId`)
 * it seeds the baseline from `users.getProfile` and returns no events. Otherwise
 * it lists history since the stored point: `messagesAdded` become `message.created`
 * events, `messagesDeleted` become tombstones. A 404 (expired history) raises
 * {@link GmailHistoryExpiredError} so the worker runs a bounded resync.
 */
export const runGmailIncrementalSync = async (
  client: GmailClient,
  deps: GoogleConnectorDeps,
  connection: ConnectorConnectionContext,
  checkpoint: SyncCheckpoint,
): Promise<SyncResult> => {
  const access = connection.credential.accessToken
  const emailAddress = connection.externalTenantId
  const cursor = decodeIncrementalCursor(checkpoint.cursor)

  if (!cursor.historyId) {
    const { historyId } = await client.getProfile(access)
    const seeded: IncrementalCursor = { historyId }
    return {
      events: [],
      checkpoint: { ...checkpoint, cursor: encodeCursor(seeded) },
      hasMore: false,
    }
  }

  const history = await client.listHistory(access, {
    startHistoryId: cursor.historyId,
    pageToken: cursor.pageToken,
  })
  if (history === null) {
    throw new GmailHistoryExpiredError(connection.externalUserId, cursor.historyId)
  }

  const deletionAt = new Date(nowMs(deps)).toISOString()
  const events = await collectHistoryEvents(
    client,
    access,
    emailAddress,
    deletionAt,
    history.history,
  )

  const nextPageToken = history.nextPageToken
  const advancedHistoryId = history.historyId ?? cursor.historyId
  const nextCursor: IncrementalCursor = nextPageToken
    ? { historyId: cursor.historyId, pageToken: nextPageToken }
    : { historyId: advancedHistoryId }

  return {
    events,
    checkpoint: {
      ...checkpoint,
      cursor: encodeCursor(nextCursor),
      ...boundsOf(events, checkpoint),
    },
    hasMore: Boolean(nextPageToken),
  }
}
