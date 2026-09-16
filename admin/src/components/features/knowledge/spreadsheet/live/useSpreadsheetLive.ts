import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type SpreadsheetIntent,
  type SpreadsheetPresenceEvent,
  type SpreadsheetPresenceFrame,
} from '@nessie/schemas'
import { knowledgeKeys } from '../../../../../facades/knowledge/keys'
import type { KnowledgeVersionRecord } from '../../../../../facades/knowledge/hooks'
import {
  createPresenceSender,
  submitSpreadsheetBatch,
  useSpreadsheetLiveLane,
  useSpreadsheetOpsFetcher,
} from '../../../../../facades/knowledge/spreadsheet-live'
import { useApiClient } from '../../../../../providers/ApiClientProvider'
import { useAuthSession } from '../../../../../providers/AuthSessionProvider'
import type { SpreadsheetPeer } from '../PresenceStrip'
import type { SpreadsheetVersionSavedNotice } from '../SpreadsheetVersionSavedNotice'
import type { WorkbookSession } from '../WorkbookHost'
import type { BridgeFlush, PresenceFrame } from '../spreadsheet-model-bridge'
import { applyIntents } from './apply-intent'
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_REANNOUNCE_MS,
  clipDraft,
  createFrameThrottle,
  createPresenceStore,
} from './presence-store'
import {
  createSpreadsheetSync,
  type LiveStatus,
  type SpreadsheetSync,
  type SyncState,
} from './sync-engine'

/**
 * Everything Phase 3b owes the pane, in one hook: the lane, the ordering
 * machine, the presence sender and receiver, and the notices.
 *
 * The division of labour is deliberate and is what keeps the rules testable.
 * `sync-engine.ts` decides *what* to do with a batch and has no `fetch`, no
 * React and no engine in it. `spreadsheet-live.ts` is the wire.
 * `WorkbookSession` is the engine. This file is the only place all three meet,
 * and it is mostly plumbing — which is the point: a rule that lives here is a
 * rule nothing can test.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md
 */

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    // A uuid shape, for an environment without the Web Crypto API (the unit
    // suite's jsdom). `clientOpId` is a uuid in the wire contract.
    : '00000000-0000-4000-8000-000000000000'.replace(/0/g, () =>
        Math.floor(Math.random() * 16).toString(16))

/** What the flush handler does with the diffs the bridge just drained. */
type FlushMode = 'normal' | 'discard' | 'capture'

export type SpreadsheetLive = {
  liveStatus: LiveStatus
  /** Peers, newest first, for the strip. */
  peers: SpreadsheetPeer[]
  /** The same peers as raw frames, for the overlay's geometry. */
  peerFrames: SpreadsheetPresenceEvent[]
  conflictNotice: string | null
  dismissConflictNotice: () => void
  liveError: string | null
  dismissLiveError: () => void
  engineMigrating: boolean
  versionNotice: SpreadsheetVersionSavedNotice | null
  /** Wired into the pane's seams. */
  onFlush: (flush: BridgeFlush) => void
  onPresence: (frame: PresenceFrame) => void
  onSession: (session: WorkbookSession | null) => void
  /** The pane's own draft observer feeds this. */
  onDraft: (text: string | null) => void
  /** Unacknowledged batches, for the e2e run and the "saving" affordance. */
  unsent: number
  /**
   * Bumped whenever the model changed under the layers drawn over the canvas,
   * so they re-measure instead of going stale. It is `appliedSeq` itself: a
   * structural batch is exactly what moves a cell, and a batch is exactly what
   * advances the seq.
   */
  revision: number
}

export const useSpreadsheetLive = (input: {
  canWrite: boolean
  pageId?: string
}): SpreadsheetLive => {
  const { canWrite, pageId } = input
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const { token } = useAuthSession()
  const fetchOps = useSpreadsheetOpsFetcher(pageId)

  // One per open pane, for the pane's lifetime: the server names exactly this
  // pane when its socket closes, and two panes on one page are two peers.
  const clientIdRef = useRef<string | undefined>(undefined)
  clientIdRef.current ??= newId()
  const clientId = clientIdRef.current

  const sessionRef = useRef<WorkbookSession | null>(null)
  const syncRef = useRef<SpreadsheetSync | null>(null)
  const flushMode = useRef<FlushMode>('normal')
  const captured = useRef<Uint8Array | null>(null)
  const draftRef = useRef<{ r: number; c: number; text: string } | null>(null)

  const [state, setState] = useState<SyncState>({
    appliedSeq: 0,
    unsent: 0,
    status: 'connecting',
    notice: null,
    error: null,
    engineMigrating: false,
  })
  const [peerFrames, setPeerFrames] = useState<SpreadsheetPresenceEvent[]>([])
  const [versionNotice, setVersionNotice] = useState<SpreadsheetVersionSavedNotice | null>(null)

  const peersRef = useRef(createPresenceStore({ selfClientId: clientId }))
  const publishPeers = useCallback(() => {
    setPeerFrames(peersRef.current.list().map((peer) => peer.event))
  }, [])

  // ── Presence out ──────────────────────────────────────────────────────────
  const senderRef = useRef<ReturnType<typeof createPresenceSender> | null>(null)
  const throttleRef = useRef<ReturnType<typeof createFrameThrottle> | null>(null)
  useEffect(() => {
    if (!pageId) return undefined
    const sender = createPresenceSender({ clientId, pageId, token })
    const throttle = createFrameThrottle({ send: (frame) => sender.send(frame) })
    senderRef.current = sender
    throttleRef.current = throttle
    return () => {
      throttle.dispose()
      sender.leave()
      senderRef.current = null
      throttleRef.current = null
    }
  }, [clientId, pageId, token])

  const frameNow = useCallback((): SpreadsheetPresenceFrame | null => {
    const session = sessionRef.current
    if (!session) return null
    const view = session.model.getSelectedView()
    return {
      clientId,
      sheet: view.sheet,
      selection: {
        r0: Math.min(view.range[0], view.range[2]),
        c0: Math.min(view.range[1], view.range[3]),
        r1: Math.max(view.range[0], view.range[2]),
        c1: Math.max(view.range[1], view.range[3]),
      },
      cursor: { r: view.row, c: view.column },
      // A reader's draft is refused by the server, and rightly: a pane that
      // cannot write has nothing to show anybody typing.
      draft: canWrite ? draftRef.current : null,
      ts: new Date().toISOString(),
    }
  }, [canWrite, clientId])

  const announce = useCallback((immediate = false): void => {
    const frame = frameNow()
    if (!frame) return
    if (immediate) throttleRef.current?.sendNow(frame)
    else throttleRef.current?.push(frame)
  }, [frameNow])

  // The heartbeat, so a peer that has been sitting still for a minute does not
  // expire out of everybody else's strip. Paused while the tab is hidden: a
  // background tab is not somebody who is here.
  useEffect(() => {
    if (!pageId) return undefined
    const beat = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      announce(true)
    }, PRESENCE_HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [announce, pageId])

  // A socket close is the only reliable signal that a pane went away, but it
  // arrives when the server notices — `pagehide` is what makes a deliberate
  // close instant. Both paths publish the same `leave`.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onHide = (): void => senderRef.current?.leave()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  // ── The ordering machine ──────────────────────────────────────────────────
  const rebootstrap = useCallback(() => {
    if (!pageId) return
    void queryClient.resetQueries({ queryKey: knowledgeKeys.spreadsheet(pageId) })
  }, [pageId, queryClient])

  const onSession = useCallback((session: WorkbookSession | null) => {
    sessionRef.current = session
    syncRef.current?.dispose()
    syncRef.current = null
    peersRef.current.clear()
    publishPeers()
    if (!session || !pageId) return

    syncRef.current = createSpreadsheetSync(
      {
        applyExternal: (diffs) => session.applyExternal(diffs),
        redraw: () => session.redraw(),
        fetchOps,
        submit: (batch) => submitSpreadsheetBatch(apiClient, pageId, batch),
        // Rule 4 (a): undo the pending batches and throw the undo's own diffs
        // away. `flushNow` drains the queue; the mode is what drops it.
        rollback: (count) => {
          if (count <= 0) return
          flushMode.current = 'discard'
          try {
            session.model.pauseEvaluation()
            for (let index = 0; index < count; index += 1) session.model.undo()
            session.model.resumeEvaluation()
            session.model.evaluate()
            session.flushNow()
          } finally {
            flushMode.current = 'normal'
          }
        },
        // Rule 4 (c)+(d): re-issue the shifted intents as genuine engine calls,
        // then take the diffs they produced. They are recorded by the bridge
        // like any other edit, which is what makes the replacement batch a
        // real batch rather than a re-labelled copy of the refused one.
        replay: (intents: SpreadsheetIntent[]) => {
          flushMode.current = 'capture'
          captured.current = null
          try {
            session.model.pauseEvaluation()
            applyIntents(session.model as never, intents)
            session.model.resumeEvaluation()
            session.model.evaluate()
            session.flushNow()
          } finally {
            flushMode.current = 'normal'
          }
          session.redraw()
          return captured.current
        },
        rebootstrap,
        onState: setState,
        newOpId: newId,
      },
      session.appliedSeq,
    )
    // The bootstrap stopped at the first gap it could not inline; those seqs
    // are fetched before anything else happens.
    if (session.missingSeqs.length > 0) void syncRef.current.resume()
    announce(true)
    // `fetchOps` and `apiClient` are stable refs; `announce` closes over a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, fetchOps, pageId, publishPeers, rebootstrap])

  const onFlush = useCallback((flush: BridgeFlush) => {
    if (flushMode.current === 'discard') return
    if (flushMode.current === 'capture') { captured.current = flush.diffs; return }
    const session = sessionRef.current
    syncRef.current?.enqueue({
      diffs: flush.diffs,
      intents: flush.intents,
      // A call the contract has no intent shape for still ships its diffs; it
      // simply cannot be replayed, and a structural refusal has to say so.
      unrebasableCalls: Math.max(0, flush.calls.length - flush.intents.length),
      sheet: session ? session.model.getSelectedView().sheet : 0,
    })
  }, [])

  const onPresence = useCallback((_frame: PresenceFrame) => {
    // The bridge's frame carries the same view this reads off the model, but
    // the draft does not go through the bridge — so one builder, always.
    announce()
  }, [announce])

  const onDraft = useCallback((text: string | null) => {
    const session = sessionRef.current
    if (!session) return
    if (text === null) {
      if (!draftRef.current) return
      draftRef.current = null
    } else {
      const view = session.model.getSelectedView()
      draftRef.current = { r: view.row, c: view.column, text: clipDraft(text) }
    }
    // Not `sendNow`: a draft is one frame per keystroke, which is exactly what
    // the throttle exists for. The *clearing* frame rides the same path, so a
    // commit and the batch that follows it cannot arrive out of order.
    announce()
  }, [announce])

  // ── The lane ──────────────────────────────────────────────────────────────
  const reannounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useSpreadsheetLiveLane({
    clientId,
    enabled: Boolean(pageId),
    onClose: () => { syncRef.current?.suspend() },
    onOpen: () => { void syncRef.current?.resume(); announce(true) },
    onEvent: (event) => {
      switch (event.event) {
        case 'sheet.ops':
          syncRef.current?.receive(event.data)
          break
        case 'sheet.presence':
          if (peersRef.current.receive(event.data)) publishPeers()
          break
        case 'sheet.presence.leave':
          if (peersRef.current.leave(event.data.clientId)) publishPeers()
          break
        case 'sheet.presence.request':
          // Spread over half a second so N panes on one page do not answer a
          // join in lockstep — the same reason the retry ladder is jittered.
          if (reannounce.current) clearTimeout(reannounce.current)
          reannounce.current = setTimeout(
            () => announce(true),
            Math.random() * PRESENCE_REANNOUNCE_MS,
          )
          break
        case 'sheet.snapshot':
          // A version list is the only page-level thing a batch can change, and
          // it changes only here: invalidating per batch would refetch the list
          // on every keystroke somebody else makes.
          void queryClient.invalidateQueries({ queryKey: knowledgeKeys.versions(pageId) })
          void noticeForSnapshot(queryClient, pageId, event.data.versionId).then(setVersionNotice)
          break
        case 'sheet.closed':
          rebootstrap()
          break
      }
    },
    ...(pageId ? { pageId } : {}),
  })

  // Expiry has to be driven by a clock, not by arrivals: a peer who closed a
  // laptop lid sends nothing at all, and "nothing" is exactly the signal.
  useEffect(() => {
    const timer = setInterval(() => {
      if (peersRef.current.expire()) publishPeers()
    }, 5_000)
    return () => clearInterval(timer)
  }, [publishPeers])

  useEffect(() => () => {
    syncRef.current?.dispose()
    syncRef.current = null
    if (reannounce.current) clearTimeout(reannounce.current)
  }, [])

  const peers: SpreadsheetPeer[] = useMemo(
    () =>
      peerFrames.map((frame) => ({
        actor: frame.actor,
        cell: frame.cursor ? { c: frame.cursor.c, r: frame.cursor.r } : null,
        sheetName: frame.sheetName,
      })),
    [peerFrames],
  )

  return {
    conflictNotice: state.notice,
    dismissConflictNotice: () => syncRef.current?.dismissNotice(),
    dismissLiveError: () => syncRef.current?.dismissError(),
    engineMigrating: state.engineMigrating,
    liveError: state.error,
    liveStatus: state.status,
    onDraft,
    onFlush,
    onPresence,
    onSession,
    peerFrames,
    peers,
    revision: state.appliedSeq,
    unsent: state.unsent,
    versionNotice,
  }
}

/**
 * The "Saved a version before … — Restore" line, for a snapshot somebody
 * *else* triggered.
 *
 * `sheet.snapshot` carries only `{versionId, seq}`, so what the snapshot was
 * taken *before* has to come from the version row — which is where the write
 * door already wrote it, as `before: delete rows 2-4`. Only a pre-destructive
 * snapshot earns the notice: an idle or compaction snapshot is bookkeeping and
 * nobody needs to be told about it.
 */
const noticeForSnapshot = async (
  queryClient: ReturnType<typeof useQueryClient>,
  pageId: string | undefined,
  versionId: string,
): Promise<SpreadsheetVersionSavedNotice | null> => {
  if (!pageId) return null
  await queryClient.refetchQueries({ queryKey: knowledgeKeys.versions(pageId) })
  const versions = queryClient.getQueryData<KnowledgeVersionRecord[]>(
    knowledgeKeys.versions(pageId),
  )
  const version = versions?.find((entry) => entry.id === versionId)
  const comment = version?.changeComment ?? ''
  if (!version || !comment.startsWith('before: ')) return null
  return {
    action: comment.slice('before: '.length),
    versionId: version.id,
    versionNumber: version.versionNumber,
  }
}
