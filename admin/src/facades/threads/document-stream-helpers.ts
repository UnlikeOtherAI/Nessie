// Live document composition *and editing* (`kb_document_compose`): the wire/state
// shape plus the pure merge and repair helpers the thread stream hook uses.
// Deliberately React-free so it is unit-testable
// (`admin/test/document-stream-helpers.test.ts`), exactly like `thinking.ts`.
//
// Rendering-side helpers (block splitting, tail repair, cursor location) live in
// `document-markdown.ts`.

import type {
  DocumentStreamErrorReason,
  DocumentStreamStatus,
  DocumentStreamSummary,
  DocumentStreamTarget,
} from '@nessie/schemas'

// What `stream.document.done` reported: the file that actually landed in the
// knowledge base, which is what the dialog's "Open document" button needs.
export type DocumentStreamResult = {
  chars: number
  pageId: string
  published: boolean
  spaceId: string
  spaceName: string | null
  title: string
  versionNumber: number
}

/**
 * One document being written into the open thread. `markdown` always holds the
 * composed document exactly as received so far; `cursor` is where the agent is
 * currently writing into it, in UTF-16 code units — the unit every
 * `stream.document.*` offset is expressed in, so no encoding step is ever
 * needed. `appliedSeq` is the ordering authority: since an edit can land
 * anywhere, offsets no longer increase and only `seq` says what comes next.
 */
export type DocumentStreamEntry = {
  appliedSeq: number
  cursor: number
  // Which edit the cursor belongs to. A change of value means a *new* edit
  // began somewhere else in the document — a deliberate jump, not drift.
  editIndex: number
  errorReason?: DocumentStreamErrorReason | null
  markdown: string
  // A frame arrived out of the entry's reach — a `seq` past the next one, or an
  // offset past the end of the text we hold — so the entry must be repaired
  // from the bootstrap route before it can grow.
  needsBootstrap?: boolean
  result?: DocumentStreamResult
  runId: string
  sessionId: string
  startedAt: string
  status: DocumentStreamStatus
  target: DocumentStreamTarget
  title: string | null
}

export type DocumentDelta = {
  content: string
  offset: number
  seq: number
}

export type DocumentEdit = {
  editIndex: number
  offset: number
  removeLength: number
}

/** A frame held back while a bootstrap request is in flight. */
export type DocumentFrame =
  | { delta: DocumentDelta; kind: 'delta' }
  | { edit: DocumentEdit; kind: 'edit' }

// `duplicate` = a seq already applied (a bootstrap and the live lane overlap by
// design); `gap` = the frame cannot be placed against what we hold.
export type DeltaOutcome = 'applied' | 'duplicate' | 'gap'

export type DeltaApplication = {
  entry: DocumentStreamEntry
  outcome: DeltaOutcome
}

export type EditApplication = {
  entry: DocumentStreamEntry
  outcome: 'applied' | 'gap'
}

export type BootstrapWatermark = {
  lastSeq?: number
  markdown: string
  offset: number
}

export type BootstrapMerge = {
  entry: DocumentStreamEntry
  // The watermark is still behind the buffered frames: the durable lane trails
  // the live one, so the caller re-fetches rather than applying across a hole.
  needsRefetch: boolean
}

export type DocumentReconciliation = {
  // Sessions whose durable watermark must be read: a late-joined session with
  // no local text, and a locally-live session the bootstrap no longer lists
  // (the zombie case — one session GET decides whether it finished or died).
  detailSessionIds: string[]
  sessions: DocumentStreamEntry[]
}

const EMPTY_TARGET: DocumentStreamTarget = {
  parentPageId: null,
  parentTitle: null,
  spaceId: null,
  spaceName: null,
}

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(value, 0), max)

export const emptyDocumentTarget = (): DocumentStreamTarget => ({ ...EMPTY_TARGET })

export const isDocumentStreamActive = (entry: DocumentStreamEntry): boolean =>
  entry.status === 'streaming' || entry.status === 'saving'

export const createDocumentStreamEntry = (input: {
  runId: string
  sessionId: string
  startedAt?: string
}): DocumentStreamEntry => ({
  appliedSeq: 0,
  cursor: 0,
  editIndex: 0,
  errorReason: null,
  markdown: '',
  runId: input.runId,
  sessionId: input.sessionId,
  startedAt: input.startedAt ?? new Date().toISOString(),
  status: 'streaming',
  target: emptyDocumentTarget(),
  title: null,
})

const resultFromSummary = (
  summary: DocumentStreamSummary,
): DocumentStreamResult | undefined =>
  summary.pageId && summary.versionNumber && summary.target.spaceId
    ? {
        chars: summary.chars,
        pageId: summary.pageId,
        published: summary.published,
        spaceId: summary.target.spaceId,
        spaceName: summary.target.spaceName,
        title: summary.title ?? 'Document',
        versionNumber: summary.versionNumber,
      }
    : undefined

/** The server is the authority on everything but the text we already hold. */
export const applyDocumentSummary = (
  entry: DocumentStreamEntry,
  summary: DocumentStreamSummary,
): DocumentStreamEntry => ({
  ...entry,
  errorReason: summary.errorReason,
  result: resultFromSummary(summary) ?? entry.result,
  runId: summary.runId,
  startedAt: summary.startedAt,
  status: summary.status,
  target: summary.target,
  title: summary.title ?? entry.title,
})

export const entryFromSummary = (summary: DocumentStreamSummary): DocumentStreamEntry =>
  applyDocumentSummary(
    {
      ...createDocumentStreamEntry({
        runId: summary.runId,
        sessionId: summary.sessionId,
        startedAt: summary.startedAt,
      }),
      needsBootstrap: true,
    },
    summary,
  )

/**
 * `stream.document.edit`: the agent is about to replace `removeLength` code
 * units at `offset`. The span is spliced out immediately — so the reader sees
 * the old words go before the new ones arrive, which is what an edit looks
 * like — and the cursor moves there, which is where the following deltas will
 * insert.
 *
 * An offset past the end of what we hold means the text in between is missing:
 * splicing would corrupt the document silently, so the entry is flagged for a
 * bootstrap repair instead.
 */
export const applyDocumentEdit = (
  entry: DocumentStreamEntry,
  edit: DocumentEdit,
): EditApplication => {
  if (edit.offset > entry.markdown.length || edit.offset < 0) {
    return { entry: { ...entry, needsBootstrap: true }, outcome: 'gap' }
  }

  const removed = clamp(edit.removeLength, entry.markdown.length - edit.offset)
  return {
    entry: {
      ...entry,
      cursor: edit.offset,
      editIndex: edit.editIndex,
      markdown: `${entry.markdown.slice(0, edit.offset)}${entry.markdown.slice(
        edit.offset + removed,
      )}`,
      needsBootstrap: false,
    },
    outcome: 'applied',
  }
}

/**
 * The merge contract. `seq` is the authoritative *order* and `offset` the
 * authoritative *position* — the two are independent now that an edit can land
 * anywhere, so a delta is placed by offset but admitted only in seq order:
 *
 * - a seq at or below the last applied one → already merged, dropped whole;
 * - the next seq → inserted at its offset, cursor moved past what it wrote;
 * - a seq beyond the next one, or an offset past the end of what we hold → a
 *   hole, never applied. The entry is flagged for a bootstrap repair, because
 *   writing across a gap would corrupt the document silently.
 *
 * Composing a brand-new document is the degenerate case: offsets happen to
 * increase monotonically and every insertion lands at the end.
 */
export const applyDocumentDelta = (
  entry: DocumentStreamEntry,
  delta: DocumentDelta,
): DeltaApplication => {
  if (delta.seq <= entry.appliedSeq) {
    return { entry, outcome: 'duplicate' }
  }

  if (delta.seq > entry.appliedSeq + 1 || delta.offset > entry.markdown.length) {
    return { entry: { ...entry, needsBootstrap: true }, outcome: 'gap' }
  }

  const offset = Math.max(delta.offset, 0)
  return {
    entry: {
      ...entry,
      appliedSeq: delta.seq,
      cursor: offset + delta.content.length,
      markdown: `${entry.markdown.slice(0, offset)}${delta.content}${entry.markdown.slice(
        offset,
      )}`,
      needsBootstrap: false,
    },
    outcome: 'applied',
  }
}

const applyFrame = (
  entry: DocumentStreamEntry,
  frame: DocumentFrame,
): DeltaApplication | EditApplication =>
  frame.kind === 'delta'
    ? applyDocumentDelta(entry, frame.delta)
    : applyDocumentEdit(entry, frame.edit)

/**
 * Fold the durable watermark in, then the frames buffered while it was in
 * flight. The watermark is compared by `seq`, never by length: an edit can make
 * a *newer* document shorter than an older one, so "further along" is a
 * question only the sequence can answer. A watermark behind what the client
 * already holds is simply older, so the local text wins; one that cannot bridge
 * the buffered frames leaves the caller re-fetching until the durable lane
 * catches up.
 *
 * Buffered frames replay in arrival order — the thread has one SSE connection,
 * so arrival order *is* the order the server published, and it is the only
 * thing that interleaves seq-carrying deltas with seq-less edits correctly.
 */
/**
 * Fold a durable read into an entry.
 *
 * The durable lane keeps *appends* for a composed document and a whole
 * *snapshot* for an edited one — a change in the middle of a document cannot be
 * expressed as a log. That difference decides what happens to frames buffered
 * while the read was in flight: an append-log watermark tells us exactly which
 * ones are already included, but a snapshot silently contains every delta
 * published before it was read, so replaying the buffer would write that text a
 * second time. For a snapshot the buffer is therefore dropped and another read
 * requested; the lane flushes every 250 ms, so it converges immediately and
 * nothing can be applied twice in the meantime.
 */
export const mergeBootstrap = (
  entry: DocumentStreamEntry,
  bootstrap: BootstrapWatermark,
  buffered: DocumentFrame[] = [],
  options: { snapshot?: boolean } = {},
): BootstrapMerge => {
  const watermark = bootstrap.lastSeq ?? 0
  // An *edit* session opens on a document that already exists, and the base is
  // published before any delta — so it arrives at seq 0, the same seq a fresh
  // entry starts at. Comparing watermarks alone would discard it and leave the
  // viewer watching an empty page while offsets pointed into a document they
  // could not see. An entry that has applied nothing has nothing to regress,
  // so adopting is always safe there.
  const holdsNothing = entry.appliedSeq === 0 && entry.markdown.length === 0
  const adopt = watermark > entry.appliedSeq
    || (holdsNothing && bootstrap.markdown.length > 0)
  let merged: DocumentStreamEntry =
    adopt
      ? {
          ...entry,
          appliedSeq: watermark,
          cursor: clamp(bootstrap.offset, bootstrap.markdown.length),
          markdown: bootstrap.markdown,
          needsBootstrap: false,
        }
      : { ...entry, needsBootstrap: false }

  if (options.snapshot && adopt) {
    return { entry: merged, needsRefetch: buffered.length > 0 }
  }

  for (const frame of buffered) {
    const application = applyFrame(merged, frame)
    if (application.outcome === 'gap') {
      return { entry: application.entry, needsRefetch: true }
    }
    merged = application.entry
  }

  return { entry: merged, needsRefetch: false }
}

/**
 * Reconcile local sessions with the bootstrap list, which is the authority on
 * what is still live. Mirrors `reconcileThreadThinking`'s zombie guard: a
 * session the client holds as live but the list no longer reports is not
 * fabricated into a status here — it is nominated for one session GET, which is
 * the only thing that knows whether it saved or died. `protectedSessionIds`
 * covers sessions that started after the request was sent.
 */
export const reconcileDocumentSessions = (
  current: DocumentStreamEntry[],
  summaries: DocumentStreamSummary[],
  protectedSessionIds: ReadonlySet<string> = new Set<string>(),
): DocumentReconciliation => {
  const unmatched = new Map(summaries.map((summary) => [summary.sessionId, summary]))
  const sessions: DocumentStreamEntry[] = []
  const detailSessionIds: string[] = []

  for (const entry of current) {
    const summary = unmatched.get(entry.sessionId)
    if (summary) {
      unmatched.delete(entry.sessionId)
      sessions.push(applyDocumentSummary(entry, summary))
      if (entry.needsBootstrap || entry.markdown.length === 0) {
        detailSessionIds.push(entry.sessionId)
      }
      continue
    }

    sessions.push(entry)
    if (isDocumentStreamActive(entry) && !protectedSessionIds.has(entry.sessionId)) {
      detailSessionIds.push(entry.sessionId)
    }
  }

  for (const summary of summaries) {
    if (!unmatched.has(summary.sessionId)) {
      continue
    }
    sessions.push(entryFromSummary(summary))
    detailSessionIds.push(summary.sessionId)
  }

  return { detailSessionIds, sessions }
}
