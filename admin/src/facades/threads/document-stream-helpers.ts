// Live document composition (`kb_document_compose`): the wire/state shape plus
// the pure merge, block-splitting and tail-repair helpers the thread stream hook
// and the streaming renderer use. Deliberately React-free so it is unit-testable
// (`admin/test/document-stream-helpers.test.ts`), exactly like `thinking.ts`.

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
 * exact bytes received so far and `offset` its length in UTF-16 code units —
 * the unit `stream.document.delta` offsets are expressed in — so a delta can be
 * merged against it without any encoding step.
 */
export type DocumentStreamEntry = {
  errorReason?: DocumentStreamErrorReason | null
  lastSeq: number
  markdown: string
  // A delta arrived past the end of `markdown`: the text in between is missing,
  // so the entry must be repaired from the bootstrap route before it can grow.
  needsBootstrap?: boolean
  offset: number
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

// `duplicate` = already in `markdown` (a bootstrap and the live lane overlap by
// design); `gap` = the delta starts past the end of what we hold.
export type DeltaOutcome = 'applied' | 'duplicate' | 'gap'

export type DeltaApplication = {
  entry: DocumentStreamEntry
  outcome: DeltaOutcome
}

export type BootstrapWatermark = {
  lastSeq?: number
  markdown: string
  offset: number
}

export type BootstrapMerge = {
  entry: DocumentStreamEntry
  // The watermark is still behind the buffered deltas: the durable lane trails
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

export const emptyDocumentTarget = (): DocumentStreamTarget => ({ ...EMPTY_TARGET })

export const isDocumentStreamActive = (entry: DocumentStreamEntry): boolean =>
  entry.status === 'streaming' || entry.status === 'saving'

export const createDocumentStreamEntry = (input: {
  runId: string
  sessionId: string
  startedAt?: string
}): DocumentStreamEntry => ({
  errorReason: null,
  lastSeq: 0,
  markdown: '',
  offset: 0,
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
 * The offset merge contract (§4.3). A delta is applied only where it is
 * contiguous with what we hold:
 *
 * - entirely below the entry's offset → already applied, dropped whole;
 * - straddling the offset → only its tail is appended;
 * - starting past the offset → a hole, never applied. The entry is flagged for
 *   a bootstrap repair instead, because appending across a gap would corrupt
 *   the document silently.
 */
export const applyDocumentDelta = (
  entry: DocumentStreamEntry,
  delta: DocumentDelta,
): DeltaApplication => {
  if (delta.offset + delta.content.length <= entry.offset) {
    return { entry, outcome: 'duplicate' }
  }

  if (delta.offset > entry.offset) {
    return { entry: { ...entry, needsBootstrap: true }, outcome: 'gap' }
  }

  const tail = delta.content.slice(entry.offset - delta.offset)
  return {
    entry: {
      ...entry,
      lastSeq: Math.max(entry.lastSeq, delta.seq),
      markdown: `${entry.markdown}${tail}`,
      needsBootstrap: false,
      offset: entry.offset + tail.length,
    },
    outcome: 'applied',
  }
}

/**
 * Fold the durable watermark in, then the deltas buffered while it was in
 * flight. A watermark behind what the client already holds is simply older, so
 * the local text wins; one behind the first buffered delta cannot be bridged at
 * all, and the caller is told to re-fetch until the durable lane catches up.
 */
export const mergeBootstrap = (
  entry: DocumentStreamEntry,
  bootstrap: BootstrapWatermark,
  buffered: DocumentDelta[] = [],
): BootstrapMerge => {
  let merged: DocumentStreamEntry =
    bootstrap.offset > entry.offset
      ? {
          ...entry,
          lastSeq: Math.max(entry.lastSeq, bootstrap.lastSeq ?? 0),
          markdown: bootstrap.markdown,
          needsBootstrap: false,
          offset: bootstrap.offset,
        }
      : { ...entry, needsBootstrap: false }

  const ordered = [...buffered].sort(
    (left, right) => left.seq - right.seq || left.offset - right.offset,
  )

  for (const delta of ordered) {
    const application = applyDocumentDelta(merged, delta)
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
      if (entry.needsBootstrap || entry.offset === 0) {
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

type OpenFence = { char: string; length: number } | null

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const BULLET_PREFIX = /^(\s*)([*+\-]|\d+[.)])(\s+)/
const THEMATIC_BREAK = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/

const openFenceFrom = (line: string): OpenFence => {
  const match = FENCE_LINE.exec(line)
  if (!match) {
    return null
  }
  const marker = match[1]
  // A backtick fence's info string may not itself contain a backtick, so
  // `` ```a`b `` opens nothing.
  if (marker.startsWith('`') && match[2].includes('`')) {
    return null
  }
  return { char: marker[0], length: marker.length }
}

const closesFence = (line: string, fence: NonNullable<OpenFence>): boolean => {
  const match = FENCE_LINE.exec(line)
  return Boolean(
    match &&
      match[1][0] === fence.char &&
      match[1].length >= fence.length &&
      match[2].trim() === '',
  )
}

/**
 * Backtick runs in one line, carrying an inline code span opened on an earlier
 * line of the same paragraph. Returns the run length still open (0 = none) so a
 * fence-lookalike sitting inside `` `…` `` is never read as a fence.
 */
const scanInlineCode = (text: string, openRun: number): number => {
  let open = openRun
  let index = 0

  while (index < text.length) {
    if (open === 0 && text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] !== '`') {
      index += 1
      continue
    }
    let run = 0
    while (index + run < text.length && text[index + run] === '`') {
      run += 1
    }
    if (open === 0) {
      open = run
    } else if (run === open) {
      open = 0
    }
    index += run
  }

  return open
}

/**
 * Split markdown at top-level blank lines that are outside fenced code, so
 * every block but the last can be frozen (parsed once, memoized) while a
 * document streams. Fence-aware for backtick and tilde fences of any length ≥ 3
 * — a longer fence closes only with an equal-or-longer fence of the same
 * character — and blind to fence-lookalikes inside inline code spans.
 */
export const splitMarkdownBlocks = (markdown: string): string[] => {
  const blocks: string[] = []
  let current: string[] = []
  let fence: OpenFence = null
  let inlineOpen = 0

  const flush = () => {
    if (current.some((line) => line.trim() !== '')) {
      blocks.push(current.join('\n'))
    }
    current = []
  }

  for (const line of markdown.split('\n')) {
    if (fence) {
      current.push(line)
      if (closesFence(line, fence)) {
        fence = null
      }
      continue
    }

    if (line.trim() === '') {
      // A blank line ends the paragraph, and an inline code span cannot cross
      // one — so the carried span dies with it.
      inlineOpen = 0
      flush()
      continue
    }

    if (inlineOpen === 0) {
      const opened = openFenceFrom(line)
      if (opened) {
        fence = opened
        current.push(line)
        continue
      }
    }

    inlineOpen = scanInlineCode(line, inlineOpen)
    current.push(line)
  }

  flush()
  return blocks
}

const toggleMarker = (stack: string[], marker: string): void => {
  if (stack[stack.length - 1] === marker) {
    stack.pop()
    return
  }
  stack.push(marker)
}

const scanEmphasis = (line: string, stack: string[]): void => {
  const body = line.replace(BULLET_PREFIX, '')
  let index = 0

  while (index < body.length) {
    const insideCode = stack[stack.length - 1]?.startsWith('`') ?? false

    if (!insideCode && body[index] === '\\') {
      index += 2
      continue
    }

    if (body[index] === '`') {
      let run = 0
      while (index + run < body.length && body[index + run] === '`') {
        run += 1
      }
      toggleMarker(stack, '`'.repeat(run))
      index += run
      continue
    }

    if (!insideCode && body[index] === '*') {
      let run = 0
      while (index + run < body.length && body[index + run] === '*') {
        run += 1
      }
      let remaining = run
      while (remaining >= 2) {
        toggleMarker(stack, '**')
        remaining -= 2
      }
      if (remaining === 1) {
        toggleMarker(stack, '*')
      }
      index += run
      continue
    }

    index += 1
  }
}

/**
 * A render-only repaired copy of the block still being written: close an
 * unclosed fence so a streaming code block renders *as* a code block, and close
 * unbalanced trailing `**` / `*` / `` ` `` in the order they were opened. Half
 * written links stay literal text — they complete on their own a few tokens
 * later, and inventing a target would be worse than the flicker.
 *
 * Stored state is never touched: it always holds the exact received bytes.
 */
export const repairStreamingTail = (tailBlock: string): string => {
  let fence: OpenFence = null
  const stack: string[] = []

  for (const line of tailBlock.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null
      }
      continue
    }

    const opened = openFenceFrom(line)
    if (opened && stack.length === 0) {
      fence = opened
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      continue
    }

    scanEmphasis(line, stack)
  }

  if (fence) {
    const separator = tailBlock.endsWith('\n') ? '' : '\n'
    return `${tailBlock}${separator}${fence.char.repeat(fence.length)}`
  }

  let repaired = tailBlock
  while (stack.length > 0) {
    repaired += stack.pop()
  }
  return repaired
}
