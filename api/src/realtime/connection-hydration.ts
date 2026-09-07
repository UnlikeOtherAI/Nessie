import type { PgRealtimeTransport } from '@nessie/runtime'

import {
  formatRealtimeGapEvent,
  formatSseEvent,
  formatUserSseEvent,
  type ThreadSseConnection,
  type UserSseConnection,
} from './notification-delivery.js'
import { defaultFanOutLogger, type RealtimeFanOutLogger } from './watermark.js'

/**
 * Reading a registered connection up to the head of the log, from its own
 * watermark.
 *
 * Split out of `hub.ts` because it is now run from two places rather than one.
 * A connection is hydrated when it is first registered, and again whenever the
 * replica's LISTEN connection comes back after a drop (horizontal-scaling
 * invariant 9, audit 2.2) — the two must read the same rows, apply the same
 * live-only exclusions and move the same watermarks, or a recovered connection
 * would be repaired differently from a fresh one.
 */

// stream.start, stream.reasoning, stream.thinking.tool, stream.delta and
// stream.document.delta are live-only — don't replay from backlog. A
// reconnecting client missed the live stream; the final message is already in
// the messages table, an in-flight run's thought log is re-fetched over REST
// (GET /api/threads/:threadId/runs/:runId/thinking) and a composing document
// over GET /api/threads/:threadId/document-streams/:sessionId. Replaying live
// chunks would show a zombie pending message, orphaned reasoning, or duplicated
// document text until the terminator arrives. The document start/meta/done/
// error/target events deliberately stay replayable, like stream.done: a
// reconnect must still learn a session began or ended.
const LIVE_ONLY_THREAD_EVENTS = new Set([
  'stream.start',
  'stream.reasoning',
  'stream.thinking.tool',
  'stream.delta',
  'stream.document.delta',
])

/**
 * Write whatever arrived while the backlog read was in flight, then open the
 * connection to live delivery again.
 *
 * Every path that ends a hydration calls this, including the resync's failure
 * arm — the one path that does not is a first registration that failed, where
 * the connection is dropped from the registry instead. A connection left
 * `hydrating` in the registry receives nothing and grows `pending` without
 * bound, which is a worse outcome than the gap the re-read was closing.
 */
const finishThreadHydration = (connection: ThreadSseConnection): void => {
  while (connection.pending.length > 0) {
    const batch = connection.pending
    connection.pending = []
    batch.sort((left, right) => left.sequence - right.sequence)

    for (const notification of batch) {
      if (notification.sequence <= connection.lastSequence) {
        continue
      }

      connection.response.write(formatSseEvent(notification))
      connection.lastSequence = notification.sequence
    }
  }
  connection.hydrating = false
}

const finishUserHydration = (connection: UserSseConnection): void => {
  while (connection.pending.length > 0) {
    const batch = connection.pending
    connection.pending = []
    batch.sort((left, right) => (left.id < right.id ? -1 : 1))

    for (const event of batch) {
      if (event.id <= connection.lastEventId) {
        continue
      }

      connection.response.write(formatUserSseEvent(event))
      connection.lastEventId = event.id
    }
  }
  connection.hydrating = false
}

export const createConnectionHydration = (input: {
  logger?: RealtimeFanOutLogger
  threadSseConnections: Set<ThreadSseConnection>
  transport: Pick<PgRealtimeTransport, 'listRealtimeEventsAfter' | 'listThreadEvents'>
  userSseConnections: Set<UserSseConnection>
}) => {
  const logger = input.logger ?? defaultFanOutLogger

  /** Caller sets `hydrating` before calling and owns the error. */
  const hydrateThreadConnection = async (connection: ThreadSseConnection): Promise<void> => {
    const backlog = await input.transport.listThreadEvents(
      connection.threadId,
      connection.lastSequence,
    )
    for (const event of backlog) {
      if (event.sequence <= connection.lastSequence) {
        continue
      }

      if (LIVE_ONLY_THREAD_EVENTS.has(event.event)) {
        // The watermark still advances across them, so the stream carries on
        // from the real head of the log.
        connection.lastSequence = event.sequence
        continue
      }

      connection.response.write(formatSseEvent({ kind: 'sse', ...event }))
      connection.lastSequence = event.sequence
    }

    finishThreadHydration(connection)
  }

  const hydrateUserConnection = async (connection: UserSseConnection): Promise<void> => {
    const backlog = await input.transport.listRealtimeEventsAfter({
      afterEventId: connection.lastEventId,
      channelIds: [...connection.channelIds],
      organizationId: connection.organizationId,
      userId: connection.userId,
    })
    for (const event of backlog.events) {
      if (event.id <= connection.lastEventId) {
        continue
      }

      connection.response.write(formatUserSseEvent(event))
      connection.lastEventId = event.id
    }

    if (backlog.truncated) {
      // The replay cap cut this one short, so the client is behind by an
      // unknown amount and cannot find out on its own: its `Last-Event-ID` now
      // points at the last row it received, and every live event that follows
      // carries the watermark further past what the cap withheld. Replay is
      // `id > watermark`, so a later reconnect will not return them either.
      // The frame carries no `id:` — it is not an event and must not move that
      // watermark — and the client answers it by re-reading over REST.
      connection.response.write(formatRealtimeGapEvent())
    }

    finishUserHydration(connection)
  }

  /**
   * Re-read the backlog for every connection this replica already holds.
   *
   * Run when the LISTEN connection comes back. Sockets are kept alive by
   * keepalives, so a client whose events were swallowed by the gap has no way
   * to know and no reason to reconnect; the watermark each connection carries is
   * what makes the gap recoverable from this side.
   *
   * A connection that is *still* hydrating is skipped rather than hydrated
   * twice, and that is not a hole: this runs after the `LISTEN` has been
   * re-issued, so such a connection's own in-flight read is guaranteed to
   * observe the log at or after the moment live delivery resumed, and anything
   * published from that moment on is already queued in its `pending`.
   *
   * WebSocket connections carry no watermark — they are live-only by
   * construction, with no replay and no `Last-Event-ID` — so there is nothing to
   * re-read for them and they are deliberately not touched here.
   */
  const resyncRegisteredConnections = async (): Promise<void> => {
    for (const connection of [...input.threadSseConnections]) {
      if (connection.hydrating) {
        continue
      }
      connection.hydrating = true
      try {
        await hydrateThreadConnection(connection)
      } catch (error) {
        // Never rethrow: one unreadable connection must not cost the rest of
        // the replica its recovery. Live delivery is restored for this one
        // either way, leaving it exactly as behind as it was before the attempt.
        finishThreadHydration(connection)
        logger.warn(
          { err: String(error), lane: 'thread', threadId: connection.threadId },
          'realtime backlog re-read after LISTEN recovery failed for a connection',
        )
      }
    }

    for (const connection of [...input.userSseConnections]) {
      if (connection.hydrating) {
        continue
      }
      connection.hydrating = true
      try {
        await hydrateUserConnection(connection)
      } catch (error) {
        finishUserHydration(connection)
        logger.warn(
          { err: String(error), lane: 'user', userId: connection.userId },
          'realtime backlog re-read after LISTEN recovery failed for a connection',
        )
      }
    }
  }

  return { hydrateThreadConnection, hydrateUserConnection, resyncRegisteredConnections }
}
