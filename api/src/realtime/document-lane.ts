import type { RealtimeNotificationPayload } from '@nessie/runtime'

import { createEntitlementGate } from './delivery-entitlements.js'

/**
 * The per-document live lane: connection bookkeeping and the fan-out branch,
 * kept out of `notification-delivery.ts` because that file is already near the
 * 500-line cap (AGENTS.md). It is called from exactly two seams there —
 * `deliverNotification` and the connection registry — so the lane's rules live
 * in one place.
 *
 * Everything on this lane is ephemeral by construction: no `Last-Event-ID`, no
 * hydration, no pending buffer. A client that missed an event repairs over
 * REST, so a saturated socket drops rather than queues.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md
 */

type DocumentResponseSink = {
  once: (event: 'drain', listener: () => void) => unknown
  write: (chunk: string) => boolean
  end?: () => unknown
  writableEnded?: boolean
}

export type DocumentSseConnection = {
  kind: 'document'
  pageId: string
  spaceId: string
  organizationId: string
  userId: string
  /** One per open pane, so a `leave` can name exactly the pane that closed. */
  clientId: string
  response: DocumentResponseSink
  /**
   * True while the socket's write buffer is backed up. Ephemeral events are
   * dropped for the duration instead of queued: they carry no sequence, and a
   * client that sees a `seq` gap re-reads from the catch-up route anyway.
   */
  saturated: boolean
}

export type DocumentNotification = Extract<RealtimeNotificationPayload, { kind: 'document' }>

export const formatDocumentSseEvent = (document: DocumentNotification['document']): string =>
  `event: ${document.event}\ndata: ${JSON.stringify(document.data)}\n\n`

const writeDocumentSseEvent = (
  connection: DocumentSseConnection,
  document: DocumentNotification['document'],
): void => {
  if (connection.saturated) return
  if (!connection.response.write(formatDocumentSseEvent(document))) {
    connection.saturated = true
    connection.response.once('drain', () => {
      connection.saturated = false
    })
  }
}

/**
 * A notification is whatever a publisher on *another replica* put on the wire,
 * so its shape is not guaranteed by this build's types. A `document` envelope
 * whose payload is missing or malformed is addressed to nobody this build can
 * identify: deliver to no connection and stay up, rather than throw inside an
 * unawaited promise (which on Node 22 ends the process).
 */
const documentOf = (notification: DocumentNotification): DocumentNotification['document'] | null => {
  const document: unknown = notification.document
  if (!document || typeof document !== 'object') return null
  const candidate = document as Partial<DocumentNotification['document']>
  if (typeof candidate.pageId !== 'string' || typeof candidate.event !== 'string') return null
  return candidate as DocumentNotification['document']
}

export const createDocumentLane = (input: {
  /**
   * May this person still read this page? Asked on every event, memoised for
   * `REALTIME_ENTITLEMENT_TTL_MS` per connection — the same bargain the
   * channel and organization gates strike, so a reader who loses the space
   * stops receiving within the window rather than whenever they happen to
   * disconnect.
   *
   * Absent means **deny**. A lane with no entitlement behind it must not fan
   * a document out: unlike the ws lanes there is no declared-scope match to
   * fall back on, and `pageId` alone is an opaque id, never a grant.
   */
  canAccessKnowledgePage?: (input: {
    pageId: string
    organizationId: string
    userId: string
  }) => Promise<boolean>
  /** Clock behind the per-connection entitlement cache's TTL. */
  now?: () => number
}) => {
  const documentConnections = new Set<DocumentSseConnection>()
  // Keyed by the connection object in a WeakMap so the memo dies with the
  // socket and can never outlive the entitlement it caches.
  const gates = new WeakMap<DocumentSseConnection, (pageId: string) => Promise<boolean>>()

  const canAccessPage = (connection: DocumentSseConnection): Promise<boolean> => {
    let gate = gates.get(connection)
    if (!gate) {
      gate = createEntitlementGate(
        async (pageId: string) =>
          input.canAccessKnowledgePage
            ? input.canAccessKnowledgePage({
                pageId,
                organizationId: connection.organizationId,
                userId: connection.userId,
              })
            : false,
        input.now ? { now: input.now } : {},
      )
      gates.set(connection, gate)
    }
    return gate(connection.pageId)
  }

  const deliverDocumentNotification = async (
    notification: DocumentNotification,
  ): Promise<void> => {
    const document = documentOf(notification)
    if (!document) return
    for (const connection of documentConnections) {
      if (connection.pageId !== document.pageId) continue
      // Dropped before the entitlement query, not after: a saturated socket
      // cannot be written to either way, and the query is the expensive half.
      if (connection.saturated) continue
      if (!(await canAccessPage(connection))) continue
      writeDocumentSseEvent(connection, document)
    }
  }

  return { deliverDocumentNotification, documentConnections }
}

export type DocumentLane = ReturnType<typeof createDocumentLane>
