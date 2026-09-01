import type {
  ConnectorConnectionContext,
  NormalizedEvent,
  SyncCheckpoint,
  SyncResult,
} from '@nessie/comms-connect'

import type { SlackClient } from './client.js'
import { normalizeSlackMessage } from './normalize.js'
import { conversationType, fetchAllConversations } from './resources.js'
import type { SlackConvType, SlackMessage } from './types.js'

const HISTORY_LIMIT = '200'

type HistoryResponse = {
  ok: boolean
  error?: string
  messages?: SlackMessage[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

type ChannelRef = { id: string; type: SlackConvType }

/**
 * The compound, resumable position of a Slack sweep, JSON-packed into the
 * shared `SyncCheckpoint.cursor` string. The interface hands the connector only
 * a checkpoint (no resource id), so the connector owns the per-channel worklist
 * here: the enabled channels, the current index, and the Slack history/replies
 * pagination cursors. `oldest` is the incremental high-water mark, fixed for the
 * lifetime of one job.
 */
type SweepCursor = {
  v: 1
  built: boolean
  channels: ChannelRef[]
  idx: number
  historyCursor?: string
  threads: string[]
  replyCursor?: string
  oldest?: string
}

const freshCursor = (): SweepCursor => ({
  v: 1,
  built: false,
  channels: [],
  idx: 0,
  threads: [],
})

const decodeCursor = (raw: string | undefined): SweepCursor => {
  if (!raw) {
    return freshCursor()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SweepCursor>
    if (parsed.v === 1 && Array.isArray(parsed.channels)) {
      return {
        v: 1,
        built: parsed.built ?? false,
        channels: parsed.channels,
        idx: parsed.idx ?? 0,
        historyCursor: parsed.historyCursor,
        threads: parsed.threads ?? [],
        replyCursor: parsed.replyCursor,
        oldest: parsed.oldest,
      }
    }
  } catch {
    // Malformed cursor — restart the sweep rather than crash the job.
  }
  return freshCursor()
}

const isoToSlackOldest = (iso: string | undefined): string | undefined => {
  if (!iso) {
    return undefined
  }
  const ms = Date.parse(iso)
  // Floor to whole seconds so the exclusive `oldest` boundary can only widen
  // the window (a possible duplicate is deduped; a gap would lose messages).
  return Number.isFinite(ms) ? `${Math.floor(ms / 1000)}.000000` : undefined
}

const hasWork = (cursor: SweepCursor): boolean =>
  cursor.threads.length > 0
  || cursor.historyCursor !== undefined
  || cursor.idx < cursor.channels.length

/** Track the widest imported window across a page for the persisted checkpoint. */
class WindowBounds {
  private oldest?: string
  private newest?: string

  constructor(checkpoint: SyncCheckpoint) {
    this.oldest = checkpoint.oldestImportedAt
    this.newest = checkpoint.newestImportedAt
  }

  observe(iso: string): void {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) {
      return
    }
    if (!this.oldest || ms < Date.parse(this.oldest)) {
      this.oldest = iso
    }
    if (!this.newest || ms > Date.parse(this.newest)) {
      this.newest = iso
    }
  }

  apply(cursor: SweepCursor): SyncCheckpoint {
    return {
      cursor: JSON.stringify(cursor),
      oldestImportedAt: this.oldest,
      newestImportedAt: this.newest,
    }
  }
}

const buildWorklist = async (
  client: SlackClient,
  token: string,
): Promise<ChannelRef[]> => {
  const conversations = await fetchAllConversations(client, token)
  return conversations
    .map((conversation) => ({
      id: conversation.id,
      type: conversationType(conversation),
    }))
    // Privacy-conservative default: sweep channels; DMs/group DMs stay opt-in.
    .filter((ref) => ref.type === 'public_channel' || ref.type === 'private_channel')
}

const drainThread = async (
  client: SlackClient,
  token: string,
  connection: ConnectorConnectionContext,
  cursor: SweepCursor,
  channel: ChannelRef,
  bounds: WindowBounds,
): Promise<NormalizedEvent[]> => {
  const parentTs = cursor.threads[0] as string
  const response = await client.call<HistoryResponse>({
    method: 'conversations.replies',
    token,
    params: {
      channel: channel.id,
      ts: parentTs,
      limit: HISTORY_LIMIT,
      cursor: cursor.replyCursor,
    },
  })
  const events: NormalizedEvent[] = []
  for (const message of response.messages ?? []) {
    if (!message.ts || message.ts === parentTs) {
      continue // The parent was already emitted from history.
    }
    const event = normalizeSlackMessage({
      teamId: connection.externalTenantId,
      channelId: channel.id,
      convType: channel.type,
      message,
    })
    bounds.observe(event.occurredAt)
    events.push(event)
  }
  const next = response.response_metadata?.next_cursor || undefined
  if (next) {
    cursor.replyCursor = next
  } else {
    cursor.threads.shift()
    cursor.replyCursor = undefined
  }
  return events
}

const fetchHistoryPage = async (
  client: SlackClient,
  token: string,
  connection: ConnectorConnectionContext,
  cursor: SweepCursor,
  channel: ChannelRef,
  bounds: WindowBounds,
): Promise<NormalizedEvent[]> => {
  const response = await client.call<HistoryResponse>({
    method: 'conversations.history',
    token,
    params: {
      channel: channel.id,
      limit: HISTORY_LIMIT,
      cursor: cursor.historyCursor,
      oldest: cursor.oldest,
    },
  })
  const events: NormalizedEvent[] = []
  for (const message of response.messages ?? []) {
    if (!message.ts) {
      continue
    }
    const event = normalizeSlackMessage({
      teamId: connection.externalTenantId,
      channelId: channel.id,
      convType: channel.type,
      message,
    })
    bounds.observe(event.occurredAt)
    events.push(event)
    if ((message.reply_count ?? 0) > 0) {
      cursor.threads.push(message.ts)
    }
  }
  cursor.historyCursor = response.response_metadata?.next_cursor || undefined
  return events
}

/**
 * Advance a Slack sweep by exactly one network unit of work (one history page,
 * or one thread-replies page) and return a page-bounded {@link SyncResult}. The
 * worker persists `events` idempotently, writes the updated `checkpoint`, and
 * calls again while `hasMore` is true. `phase: 'incremental'` seeds `oldest`
 * from the prior job's high-water mark so only newer messages are pulled.
 */
export const runSlackSweep = async (
  client: SlackClient,
  connection: ConnectorConnectionContext,
  checkpoint: SyncCheckpoint,
  phase: 'history' | 'incremental',
): Promise<SyncResult> => {
  const token = connection.credential.accessToken
  const cursor = decodeCursor(checkpoint.cursor)
  const bounds = new WindowBounds(checkpoint)

  if (!cursor.built) {
    cursor.channels = await buildWorklist(client, token)
    cursor.idx = 0
    cursor.built = true
    cursor.oldest =
      phase === 'incremental'
        ? isoToSlackOldest(checkpoint.newestImportedAt)
        : undefined
  }

  if (cursor.idx >= cursor.channels.length && cursor.threads.length === 0) {
    return { events: [], checkpoint: bounds.apply(cursor), hasMore: false }
  }

  const channel = cursor.channels[cursor.idx] as ChannelRef
  const events =
    cursor.threads.length > 0
      ? await drainThread(client, token, connection, cursor, channel, bounds)
      : await fetchHistoryPage(client, token, connection, cursor, channel, bounds)

  // Only advance to the next channel once this one's history AND every thread
  // it spawned are fully drained, so pending replies never bind to the wrong
  // channel id.
  if (
    cursor.historyCursor === undefined
    && cursor.threads.length === 0
    && cursor.idx < cursor.channels.length
  ) {
    cursor.idx += 1
  }

  return { events, checkpoint: bounds.apply(cursor), hasMore: hasWork(cursor) }
}
