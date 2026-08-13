// Rendering-side markdown helpers for a document that is still being written:
// block splitting (so everything but the live block can be frozen), tail repair
// (so a half-typed fence renders as a fence), and locating the write cursor so
// the viewport can follow it. Pure and React-free, unit-tested in
// `admin/test/document-markdown.test.ts`.
//
// Split out of `document-stream-helpers.ts`, which owns the *wire* side — the
// entry state and the delta/edit merge. Two responsibilities, two files.

type OpenFence = { char: string; length: number } | null

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const BULLET_PREFIX = /^(\s*)([*+\-]|\d+[.)])(\s+)/
const THEMATIC_BREAK = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/

/**
 * The invisible character that marks the write cursor inside a rendered block.
 * U+2060 WORD JOINER: zero-width, non-breaking, and — unlike U+200B — never a
 * line-break opportunity, so inserting one cannot reflow a line.
 */
export const CURSOR_SENTINEL = '⁠'

const fenceMarker = (line: string): { info: string; marker: string } | null => {
  const match = FENCE_LINE.exec(line)
  return match && match[1] ? { info: match[2] ?? '', marker: match[1] } : null
}

const openFenceFrom = (line: string): OpenFence => {
  const found = fenceMarker(line)
  if (!found) {
    return null
  }
  // A backtick fence's info string may not itself contain a backtick, so
  // `` ```a`b `` opens nothing.
  if (found.marker.startsWith('`') && found.info.includes('`')) {
    return null
  }
  return { char: found.marker.slice(0, 1), length: found.marker.length }
}

const closesFence = (line: string, fence: NonNullable<OpenFence>): boolean => {
  const found = fenceMarker(line)
  return Boolean(
    found &&
      found.marker.startsWith(fence.char) &&
      found.marker.length >= fence.length &&
      found.info.trim() === '',
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

/** A block plus where it sits in the document, in UTF-16 code units. */
export type MarkdownBlockSpan = {
  end: number
  start: number
  text: string
}

/**
 * Split markdown at top-level blank lines that are outside fenced code, so
 * every block but the one being written can be frozen (parsed once, memoized).
 * Fence-aware for backtick and tilde fences of any length ≥ 3 — a longer fence
 * closes only with an equal-or-longer fence of the same character — and blind
 * to fence-lookalikes inside inline code spans.
 *
 * Spans carry absolute offsets because a document is no longer only appended
 * to: an edit lands at an absolute offset, and finding which block holds it
 * needs the mapping back to the source. `text` is exactly
 * `markdown.slice(start, end)` — a block's lines are always contiguous.
 */
export const splitMarkdownBlockSpans = (markdown: string): MarkdownBlockSpan[] => {
  const spans: MarkdownBlockSpan[] = []
  let current: string[] = []
  let blockStart = 0
  let blockEnd = 0
  let fence: OpenFence = null
  let inlineOpen = 0
  let lineStart = 0

  const push = (line: string) => {
    if (current.length === 0) {
      blockStart = lineStart
    }
    current.push(line)
    blockEnd = lineStart + line.length
  }

  const flush = () => {
    if (current.some((line) => line.trim() !== '')) {
      spans.push({ end: blockEnd, start: blockStart, text: current.join('\n') })
    }
    current = []
  }

  for (const line of markdown.split('\n')) {
    if (fence) {
      push(line)
      if (closesFence(line, fence)) {
        fence = null
      }
    } else if (line.trim() === '') {
      // A blank line ends the paragraph, and an inline code span cannot cross
      // one — so the carried span dies with it.
      inlineOpen = 0
      flush()
    } else {
      const opened = inlineOpen === 0 ? openFenceFrom(line) : null
      if (opened) {
        fence = opened
      } else {
        inlineOpen = scanInlineCode(line, inlineOpen)
      }
      push(line)
    }
    lineStart += line.length + 1
  }

  flush()
  return spans
}

/** The block texts alone, for callers that do not care where they sit. */
export const splitMarkdownBlocks = (markdown: string): string[] =>
  splitMarkdownBlockSpans(markdown).map((span) => span.text)

export type CursorLocation = {
  blockIndex: number
  localOffset: number
}

/**
 * Which block the write cursor is in, and where inside it. A cursor sitting in
 * the blank lines *between* blocks belongs to the block that follows it (that
 * is where the next character will appear); one past everything belongs to the
 * end of the last block, which is the pure-append case.
 */
export const locateCursorBlock = (
  spans: MarkdownBlockSpan[],
  cursor: number,
): CursorLocation | null => {
  if (spans.length === 0) {
    return null
  }

  for (const [blockIndex, span] of spans.entries()) {
    if (cursor <= span.end) {
      return { blockIndex, localOffset: Math.max(0, cursor - span.start) }
    }
  }

  const last = spans[spans.length - 1]
  return last
    ? { blockIndex: spans.length - 1, localOffset: last.end - last.start }
    : null
}

/**
 * Where the cursor marker may be inserted into a block without changing how it
 * parses: the **end of the line** the cursor is on. A line end is safe where an
 * arbitrary offset is not — it can never split a `**` run, a fence marker, a
 * bullet, or a heading's `#`s.
 *
 * Inside fenced code there is no safe position at all (the marker would land in
 * literal code, where inline text is never re-rendered), so the cursor walks
 * back to the last line before the fence opened. If nothing precedes it, the
 * answer is `null`: no marker, and the caller falls back to the block element.
 */
export const cursorMarkerOffset = (
  blockText: string,
  localOffset: number,
): number | null => {
  const target = Math.min(Math.max(localOffset, 0), blockText.length)
  let fence: OpenFence = null
  let lineStart = 0
  let lastSafeEnd: number | null = null

  for (const line of blockText.split('\n')) {
    const lineEnd = lineStart + line.length
    const opened = fence ? null : openFenceFrom(line)
    const insideFence = fence !== null || opened !== null

    if (fence) {
      if (closesFence(line, fence)) {
        fence = null
      }
    } else if (opened) {
      fence = opened
    }

    if (target <= lineEnd) {
      return insideFence ? lastSafeEnd : lineEnd
    }
    if (!insideFence) {
      lastSafeEnd = lineEnd
    }
    lineStart = lineEnd + 1
  }

  return blockText.length
}

/**
 * A render-only copy of the block holding the cursor, with `CURSOR_SENTINEL`
 * spliced in at the safe position. Stored state is never touched — it always
 * holds the exact received bytes.
 */
export const withCursorMarker = (blockText: string, localOffset: number): string => {
  const at = cursorMarkerOffset(blockText, localOffset)
  return at === null
    ? blockText
    : `${blockText.slice(0, at)}${CURSOR_SENTINEL}${blockText.slice(at)}`
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
