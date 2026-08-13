// Live document composition, client side: the six `stream.document.*` frames
// folded into per-session entries, repaired from the bootstrap route whenever a
// hole appears, and published to React in two lanes.
//
// The two lanes are the whole point. Structural changes (a session started,
// was retargeted, saved, failed) go through React state — they are rare. The
// text does not: a `setState` per provider chunk would re-render the channel
// feed for every few tokens. Deltas mutate a store the frame handler owns, and
// only the components that actually paint the document subscribe to it, each
// committing at most once per animation frame (`useDocumentStreamSnapshot`).
// The bytes are in the store the moment they come off the wire either way.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  DocumentStreamDetailResponse,
  DocumentStreamListResponse,
  DocumentStreamRetargetBody,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import {
  applyDocumentDelta,
  applyDocumentEdit,
  applyDocumentSummary,
  createDocumentStreamEntry,
  mergeBootstrap,
  reconcileDocumentSessions,
  type DocumentDelta,
  type DocumentEdit,
  type DocumentFrame,
  type DocumentStreamEntry,
} from './document-stream-helpers'

export type DocumentStreamStore = {
  read: (sessionId: string) => DocumentStreamEntry | undefined
  subscribe: (sessionId: string, listener: () => void) => () => void
}

export type DocumentStreamController = {
  bootstrapDocuments: () => void
  documentSessions: DocumentStreamEntry[]
  documentStore: DocumentStreamStore
  handleDocumentFrame: (event: string, data: DocumentFrameData) => void
}

// The union of the frames' payloads, read defensively: this is wire data.
export type DocumentFrameData = {
  chars?: number
  content?: string
  editIndex?: number
  offset?: number
  removeLength?: number
  pageId?: string
  parentPageId?: string
  parentTitle?: string
  published?: boolean
  reason?: string
  runId?: string
  seq?: number
  sessionId?: string
  spaceId?: string
  spaceName?: string
  title?: string
  versionNumber?: number
}

export const documentStreamsKey = (threadId?: string) =>
  ['threads', threadId, 'documentStreams'] as const

const documentStreamKey = (threadId: string | undefined, sessionId: string) =>
  [...documentStreamsKey(threadId), sessionId] as const

// A repair is bounded: the durable lane trails the live one by ≲250 ms, so a
// handful of attempts always closes the gap. Giving up leaves the entry flagged
// and the next reconnect tries again.
const MAX_DETAIL_ATTEMPTS = 5
const DETAIL_RETRY_MS = 250

const errorStatus = (reason: string | undefined): DocumentStreamEntry['status'] =>
  reason === 'cancelled' ? 'cancelled' : reason === 'superseded' ? 'superseded' : 'failed'

/**
 * Owns every document session of one thread. Returned to `useThreadStream`,
 * which feeds it the SSE frames it already receives — there is exactly one SSE
 * connection per thread and this does not open a second one.
 */
export const useDocumentStreams = (threadId?: string): DocumentStreamController => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const [documentSessions, setDocumentSessions] = useState<DocumentStreamEntry[]>([])

  const entriesRef = useRef(new Map<string, DocumentStreamEntry>())
  const listenersRef = useRef(new Map<string, Set<() => void>>())
  const bufferedRef = useRef(new Map<string, DocumentFrame[]>())
  const detailAttemptsRef = useRef(new Map<string, number>())
  const pendingDetailRef = useRef(new Set<string>())
  const startedAtRef = useRef(new Map<string, number>())
  const cancelledRef = useRef(false)

  const notify = useCallback((sessionId: string) => {
    for (const listener of listenersRef.current.get(sessionId) ?? []) {
      listener()
    }
  }, [])

  // Republish the structural view. Deltas deliberately never call this.
  const publish = useCallback(() => {
    setDocumentSessions([...entriesRef.current.values()])
  }, [])

  const setEntry = useCallback(
    (entry: DocumentStreamEntry, structural: boolean) => {
      entriesRef.current.set(entry.sessionId, entry)
      notify(entry.sessionId)
      if (structural) {
        publish()
      }
    },
    [notify, publish],
  )

  const bufferFrame = useCallback((sessionId: string, frame: DocumentFrame) => {
    const buffered = bufferedRef.current.get(sessionId)
    if (buffered) {
      buffered.push(frame)
      return
    }
    bufferedRef.current.set(sessionId, [frame])
  }, [])

  const fetchDetail = useCallback(
    (sessionId: string) =>
      queryClient.fetchQuery({
        queryKey: documentStreamKey(threadId, sessionId),
        queryFn: () =>
          apiClient.get<DocumentStreamDetailResponse>(
            `/api/threads/${threadId}/document-streams/${sessionId}`,
          ),
        staleTime: 0,
      }),
    [apiClient, queryClient, threadId],
  )

  /**
   * Repair one session from its durable watermark. Deltas that arrive while
   * this is in flight are buffered, then merged on the offset watermark; a
   * watermark still behind them means the durable lane has not caught up yet,
   * so it is read again rather than applied across the hole.
   */
  const requestDetail = useCallback(
    (sessionId: string) => {
      if (!threadId || pendingDetailRef.current.has(sessionId)) {
        return
      }
      const attempts = detailAttemptsRef.current.get(sessionId) ?? 0
      if (attempts >= MAX_DETAIL_ATTEMPTS) {
        return
      }
      detailAttemptsRef.current.set(sessionId, attempts + 1)
      pendingDetailRef.current.add(sessionId)

      void fetchDetail(sessionId)
        .then((detail) => {
          if (cancelledRef.current) {
            return
          }
          const current = entriesRef.current.get(sessionId)
          const base = current
            ? applyDocumentSummary(current, detail.session)
            : applyDocumentSummary(
                createDocumentStreamEntry({
                  runId: detail.session.runId,
                  sessionId,
                  startedAt: detail.session.startedAt,
                }),
                detail.session,
              )
          const buffered = bufferedRef.current.get(sessionId) ?? []
          bufferedRef.current.delete(sessionId)
          const merged = mergeBootstrap(
            base,
            { lastSeq: detail.lastSeq, markdown: detail.markdown, offset: detail.offset },
            buffered,
          )
          if (merged.needsRefetch) {
            bufferedRef.current.set(sessionId, buffered)
          } else {
            detailAttemptsRef.current.set(sessionId, 0)
          }
          setEntry(merged.entry, true)
          if (merged.needsRefetch) {
            window.setTimeout(() => requestDetail(sessionId), DETAIL_RETRY_MS)
          }
        })
        .catch(() => {
          // A session the viewer cannot read (or that never existed) is not a
          // session: drop it rather than leaving a stuck popup behind.
          if (cancelledRef.current) {
            return
          }
          entriesRef.current.delete(sessionId)
          bufferedRef.current.delete(sessionId)
          publish()
        })
        .finally(() => {
          pendingDetailRef.current.delete(sessionId)
        })
    },
    [fetchDetail, publish, setEntry, threadId],
  )

  /**
   * One path for both text frames: a session that is mid-repair buffers, a hole
   * buffers and asks for a repair, and anything else merges straight in. The
   * frame is buffered *as it arrived* so a seq-less edit keeps its place
   * between the deltas around it.
   */
  const applyFrame = useCallback(
    (sessionId: string, frame: DocumentFrame) => {
      const current = entriesRef.current.get(sessionId)
      if (!current || pendingDetailRef.current.has(sessionId)) {
        bufferFrame(sessionId, frame)
        requestDetail(sessionId)
        return
      }

      const application =
        frame.kind === 'delta'
          ? applyDocumentDelta(current, frame.delta)
          : applyDocumentEdit(current, frame.edit)

      if (application.outcome === 'duplicate') {
        return
      }
      if (application.outcome === 'gap') {
        bufferFrame(sessionId, frame)
        setEntry(application.entry, false)
        requestDetail(sessionId)
        return
      }
      setEntry(application.entry, false)
    },
    [bufferFrame, requestDetail, setEntry],
  )

  const applyDelta = useCallback(
    (sessionId: string, delta: DocumentDelta) => applyFrame(sessionId, { delta, kind: 'delta' }),
    [applyFrame],
  )

  const applyEdit = useCallback(
    (sessionId: string, edit: DocumentEdit) => applyFrame(sessionId, { edit, kind: 'edit' }),
    [applyFrame],
  )

  const handleDocumentFrame = useCallback(
    (event: string, data: DocumentFrameData) => {
      const sessionId = data.sessionId
      if (!sessionId) {
        return
      }
      const current = entriesRef.current.get(sessionId)

      if (event === 'stream.document.start') {
        startedAtRef.current.set(sessionId, Date.now())
        if (!current) {
          setEntry(
            createDocumentStreamEntry({ runId: data.runId ?? '', sessionId }),
            true,
          )
        }
        return
      }

      if (event === 'stream.document.delta') {
        applyDelta(sessionId, {
          content: data.content ?? '',
          offset: data.offset ?? 0,
          seq: data.seq ?? 0,
        })
        return
      }

      // An edit begins: a span is being replaced, so the cursor jumps to it.
      if (event === 'stream.document.edit') {
        applyEdit(sessionId, {
          editIndex: data.editIndex ?? 0,
          offset: data.offset ?? 0,
          removeLength: data.removeLength ?? 0,
        })
        return
      }

      if (event === 'stream.document.meta' || event === 'stream.document.target') {
        // A `meta`/`target` frame for an unknown session means its `start` was
        // missed; the bootstrap owns that case.
        if (!current) {
          requestDetail(sessionId)
          return
        }
        // A retarget states the whole location — a document moved to a space
        // root carries no parent, and keeping the previous folder would show a
        // path the save will not use. `meta` only fills in what it parsed.
        const retargeted = event === 'stream.document.target'
        setEntry(
          {
            ...current,
            target: {
              parentPageId:
                data.parentPageId ?? (retargeted ? null : current.target.parentPageId),
              parentTitle:
                data.parentTitle ?? (retargeted ? null : current.target.parentTitle),
              spaceId: data.spaceId ?? current.target.spaceId,
              spaceName: data.spaceName ?? (retargeted ? null : current.target.spaceName),
            },
            title: data.title ?? current.title,
          },
          true,
        )
        return
      }

      if (event === 'stream.document.done') {
        const base =
          current ?? createDocumentStreamEntry({ runId: data.runId ?? '', sessionId })
        setEntry(
          {
            ...base,
            errorReason: null,
            result: {
              chars: data.chars ?? base.markdown.length,
              pageId: data.pageId ?? '',
              published: data.published ?? false,
              spaceId: data.spaceId ?? '',
              spaceName: data.spaceName ?? null,
              title: data.title ?? base.title ?? 'Document',
              versionNumber: data.versionNumber ?? 1,
            },
            status: 'saved',
            target: {
              parentPageId: base.target.parentPageId,
              parentTitle: base.target.parentTitle,
              spaceId: data.spaceId ?? base.target.spaceId,
              spaceName: data.spaceName ?? base.target.spaceName,
            },
            title: data.title ?? base.title,
          },
          true,
        )
        return
      }

      if (event === 'stream.document.error') {
        const base =
          current ?? createDocumentStreamEntry({ runId: data.runId ?? '', sessionId })
        setEntry(
          {
            ...base,
            errorReason:
              (data.reason as DocumentStreamEntry['errorReason']) ?? 'run_failed',
            status: errorStatus(data.reason),
          },
          true,
        )
      }
    },
    [applyDelta, applyEdit, requestDetail, setEntry],
  )

  /**
   * Seed or repair from REST. `stream.document.delta` is ephemeral and never
   * replayed, so a fresh connect (and every reconnect) reads the durable list
   * and then each session's watermark. A session that announced itself after
   * this request went out is protected from the zombie guard, exactly as the
   * thinking bootstrap protects a just-started run.
   */
  const bootstrapDocuments = useCallback(() => {
    if (!threadId) {
      return
    }
    const requestedAt = Date.now()
    void queryClient
      .fetchQuery({
        queryKey: documentStreamsKey(threadId),
        queryFn: () =>
          apiClient.get<DocumentStreamListResponse>(
            `/api/threads/${threadId}/document-streams?active=1`,
          ),
        staleTime: 0,
      })
      .then((response) => {
        if (cancelledRef.current) {
          return
        }
        const protectedSessionIds = new Set(
          [...startedAtRef.current.entries()]
            .filter(([, startedAt]) => startedAt >= requestedAt)
            .map(([sessionId]) => sessionId),
        )
        const reconciliation = reconcileDocumentSessions(
          [...entriesRef.current.values()],
          response.sessions,
          protectedSessionIds,
        )
        entriesRef.current = new Map(
          reconciliation.sessions.map((session) => [session.sessionId, session]),
        )
        publish()
        for (const sessionId of reconciliation.detailSessionIds) {
          detailAttemptsRef.current.set(sessionId, 0)
          requestDetail(sessionId)
        }
      })
      .catch(() => {
        // Best effort: a failed bootstrap only costs a late joiner its popup
        // until the next reconnect.
      })
  }, [apiClient, publish, queryClient, requestDetail, threadId])

  // Opening another thread starts from nothing — a session belongs to the
  // conversation it was written in.
  useEffect(() => {
    cancelledRef.current = false
    entriesRef.current = new Map()
    listenersRef.current = new Map()
    bufferedRef.current = new Map()
    detailAttemptsRef.current = new Map()
    pendingDetailRef.current = new Set()
    startedAtRef.current = new Map()
    setDocumentSessions([])
    return () => {
      cancelledRef.current = true
    }
  }, [threadId])

  const documentStore = useMemo<DocumentStreamStore>(
    () => ({
      read: (sessionId) => entriesRef.current.get(sessionId),
      subscribe: (sessionId, listener) => {
        const listeners = listenersRef.current.get(sessionId) ?? new Set<() => void>()
        listeners.add(listener)
        listenersRef.current.set(sessionId, listeners)
        return () => {
          listeners.delete(listener)
        }
      },
    }),
    [],
  )

  return { bootstrapDocuments, documentSessions, documentStore, handleDocumentFrame }
}

const scheduleFrame = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0)
    return () => clearTimeout(timer)
  }
  const handle = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(handle)
}

/**
 * The live view of one session, committed at most once per animation frame.
 * Arrival is never delayed by rendering — the store already holds every byte —
 * and a component that paints the document re-renders once per frame instead of
 * once per provider chunk.
 */
export const useDocumentStreamSnapshot = (
  store: DocumentStreamStore,
  entry: DocumentStreamEntry,
): DocumentStreamEntry => {
  const [snapshot, setSnapshot] = useState<DocumentStreamEntry>(
    () => store.read(entry.sessionId) ?? entry,
  )

  useEffect(() => {
    let cancelFrame: (() => void) | null = null
    const commit = () => {
      cancelFrame = null
      setSnapshot(store.read(entry.sessionId) ?? entry)
    }
    const schedule = () => {
      if (cancelFrame) {
        return
      }
      cancelFrame = scheduleFrame(commit)
    }

    schedule()
    const unsubscribe = store.subscribe(entry.sessionId, schedule)
    return () => {
      cancelFrame?.()
      cancelFrame = null
      unsubscribe()
    }
  }, [entry, store])

  return snapshot
}

export type RetargetDocumentInput = DocumentStreamRetargetBody & { sessionId: string }

/**
 * The address bar's write. Before the save it re-aims where the file will land;
 * after it, the API moves the page it already created — one behaviour from the
 * user's seat.
 */
export const useRetargetDocumentStream = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<unknown, Error, RetargetDocumentInput>({
    mutationFn: (input) =>
      apiClient.post(`/api/threads/${threadId}/document-streams/${input.sessionId}/target`, {
        parentPageId: input.parentPageId ?? null,
        spaceId: input.spaceId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentStreamsKey(threadId) })
    },
  })
}

// A thread with no document facade (the info drawers render read-only feeds).
export const emptyDocumentStore: DocumentStreamStore = {
  read: () => undefined,
  subscribe: () => () => undefined,
}

