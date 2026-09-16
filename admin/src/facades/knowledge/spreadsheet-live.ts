import { useEffect, useRef } from 'react'
import { z } from 'zod'
import {
  DocumentSseEventSchema,
  SPREADSHEET_ERROR_CODES,
  SpreadsheetAppliedBatchSchema,
  type DocumentSseEvent,
  type SpreadsheetAppliedBatch,
  type SpreadsheetPresenceFrame,
} from '@nessie/schemas'
import { ApiClientError } from '@nessie/client-core'
import type {
  OutgoingBatch,
  SubmitOutcome,
} from '../../components/features/knowledge/spreadsheet/live/sync-engine'
import { getBaseUrl } from '../../lib/api-client'
import { readSseStream } from '../../lib/sse'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  classifyStreamResponse,
  runStreamConnectionLoop,
  type StreamAttemptOutcome,
} from '../threads/stream-retry'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * The spreadsheet live lane's wire, and nothing else.
 *
 * One connection per open pane, keyed by a `clientId` the pane mints, because
 * the server needs to name exactly the pane that went away when a socket
 * closes. That is the one way this lane differs from `/api/events/stream`,
 * which is shared process-wide: two panes on the same page are two peers, not
 * one subscriber counted twice.
 *
 * Ordering, replay and the offline queue are **not** here — they are in
 * `spreadsheet/live/sync-engine.ts`, which has no `fetch` in it so those rules
 * can be tested without a server. This file is the seam between them.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md
 */

const base = '/api/knowledge-base'

const OpsPageSchema = z.array(SpreadsheetAppliedBatchSchema)

export const spreadsheetLiveKeys = {
  /** Not a query key: the lane is a socket, not a cache entry. Exported so a
   *  test can name the route without spelling it twice. */
  stream: (pageId: string, clientId: string) =>
    `${base}/pages/${pageId}/live?clientId=${encodeURIComponent(clientId)}`,
}

/**
 * Catch-up. Returns batches strictly after `afterSeq`, oldest first, with the
 * diffs the fan-out may have dropped.
 */
export const useSpreadsheetOpsFetcher = (pageId?: string) => {
  const apiClient = useApiClient()
  return useRef(async (afterSeq: number): Promise<SpreadsheetAppliedBatch[]> => {
    if (!pageId) return []
    return apiClient.get(
      `${base}/pages/${pageId}/spreadsheet/ops?afterSeq=${afterSeq}`,
      OpsPageSchema,
    )
  }).current
}

/**
 * The write door, with every verdict turned into an outcome the sync engine
 * can act on. Nothing throws: a network failure and a structural refusal are
 * both ordinary states of this lane, and a thrown error would be indisting-
 * uishable from a bug at the call site.
 */
export const submitSpreadsheetBatch = async (
  apiClient: ReturnType<typeof useApiClient>,
  pageId: string,
  batch: OutgoingBatch,
): Promise<SubmitOutcome> => {
  try {
    const applied = await apiClient.post(
      `${base}/pages/${pageId}/spreadsheet/ops`,
      {
        clientOpId: batch.clientOpId,
        baseSeq: batch.baseSeq,
        diffs: batch.diffs,
        summary: batch.summary,
      },
      undefined,
      SpreadsheetAppliedBatchSchema,
    )
    return { kind: 'applied', batch: applied }
  } catch (error) {
    if (!(error instanceof ApiClientError)) return { kind: 'offline' }
    if (error.code === SPREADSHEET_ERROR_CODES.structuralConflict) {
      const details = z
        .object({ headSeq: z.number(), since: OpsPageSchema })
        .safeParse(error.details)
      // A 409 whose details will not parse is not a conflict this client can
      // repair. Re-bootstrapping is the only honest answer, and `refused` is
      // what asks for one.
      if (!details.success) {
        return { kind: 'refused', message: 'The spreadsheet changed in a way this page could not follow' }
      }
      return { kind: 'conflict', headSeq: details.data.headSeq, since: details.data.since }
    }
    if (error.code === SPREADSHEET_ERROR_CODES.engineMismatch) return { kind: 'engine-mismatch' }
    // A 5xx, a 401 mid-rotation or a dropped connection are all transient by
    // nature; only a verdict about *this batch* is terminal for it.
    if (error.status >= 500 || error.status === 401 || error.status === 0) return { kind: 'offline' }
    return { kind: 'refused', message: error.message }
  }
}

export type PresenceSender = {
  send: (frame: SpreadsheetPresenceFrame) => void
  leave: () => void
}

/**
 * Presence out. Fire-and-forget on purpose: a dropped frame is superseded by
 * the next one within 100 ms, and a retry would only make a rate-limited pane
 * louder. A refusal is swallowed for the same reason — except that a draft
 * from a reader is refused by the server, and a pane that cannot write should
 * never have sent one.
 */
export const createPresenceSender = (input: {
  pageId: string
  clientId: string
  token: string | null
}): PresenceSender => {
  const url = `${getBaseUrl()}${base}/pages/${input.pageId}/presence`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.token) headers.authorization = `Bearer ${input.token}`
  return {
    send: (frame) => {
      void fetch(url, {
        body: JSON.stringify({ frame }),
        credentials: 'include',
        headers,
        method: 'POST',
      }).catch(() => undefined)
    },
    leave: () => {
      void fetch(`${url}?clientId=${encodeURIComponent(input.clientId)}`, {
        credentials: 'include',
        headers,
        // `keepalive` is what makes this survive `pagehide`. It is not a
        // beacon: a beacon carries no Authorization header, and this route is
        // authenticated like every other.
        keepalive: true,
        method: 'DELETE',
      }).catch(() => undefined)
    },
  }
}

export type DocumentLaneListener = (event: DocumentSseEvent) => void

/**
 * Hold one document lane open for as long as `pageId` is on screen.
 *
 * The retry ladder is the repo's one policy (`../threads/stream-retry`), so a
 * drained replica hands this lane's clients back spread out rather than in
 * lockstep — the same reason the thread stream and `/api/events/stream` share
 * it. `onOpen` / `onClose` are how the sync engine learns to catch up and to
 * start queueing; every frame is validated against the lane's own union and an
 * event this build has never heard of is dropped rather than guessed at.
 */
export const useSpreadsheetLiveLane = (input: {
  clientId: string
  enabled: boolean
  onClose: () => void
  onEvent: DocumentLaneListener
  onOpen: () => void
  pageId?: string
}): void => {
  const { token } = useAuthSession()
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    if (!input.enabled || !input.pageId || !token) return undefined
    const pageId = input.pageId
    const clientId = input.clientId
    let cancelled = false
    let controller: AbortController | null = null

    const attempt = async (): Promise<StreamAttemptOutcome> => {
      const request = new AbortController()
      controller = request
      try {
        const response = await fetch(
          `${getBaseUrl()}${spreadsheetLiveKeys.stream(pageId, clientId)}`,
          {
            credentials: 'include',
            headers: { authorization: `Bearer ${token}` },
            signal: request.signal,
          },
        )
        const outcome = classifyStreamResponse(response)
        if (outcome !== 'connected' || !response.body) return outcome
        latest.current.onOpen()
        try {
          await readSseStream(response.body, (frame) => {
            if (!frame.event || !frame.data) return
            let payload: unknown
            try { payload = JSON.parse(frame.data) } catch { return }
            const parsed = DocumentSseEventSchema.safeParse({ event: frame.event, data: payload })
            if (!parsed.success) return
            latest.current.onEvent(parsed.data)
          })
        } catch {
          // Dropped mid-stream. The response itself was readable, so this is
          // still 'connected' and the loop decides on the cycle's length.
        }
        latest.current.onClose()
        return 'connected'
      } finally {
        if (controller === request) controller = null
      }
    }

    void runStreamConnectionLoop({
      attempt,
      isCancelled: () => cancelled,
      sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    })

    return () => {
      cancelled = true
      controller?.abort()
      latest.current.onClose()
    }
    // `onEvent` and friends are deliberately absent from the dependency list
    // and read through `latest` instead, so a parent that rebuilds its
    // handlers every render never churns the socket.
  }, [input.clientId, input.enabled, input.pageId, token])
}
