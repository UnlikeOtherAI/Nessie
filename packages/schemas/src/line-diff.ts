// Pure line-diff utilities, shared by every surface that shows what changed
// between two texts: the knowledge-base draft review panel (what an
// agent-authored draft changed relative to the published version), the
// worker's `kb_page_diff` tool (what a document edit changed between two
// versions) and a ticket-work kickoff (what a description edit changed). One
// implementation, so a reviewer and an agent are shown the same change.

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'tr',
  'table',
  'section',
  'article',
  'hr',
])

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

// Minimal HTML → plain-text-lines conversion: every block-level tag becomes a
// line break, every other tag is dropped, and a handful of common entities are
// decoded. This is intentionally not a full HTML parser — it only needs to be
// stable and good enough to diff two TipTap bodies line by line.
export const htmlToLines = (html: string | null | undefined): string[] => {
  if (!html) return []

  const withBreaks = html.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (_match, rawTag: string) =>
    BLOCK_TAGS.has(rawTag.toLowerCase()) ? '\n' : '',
  )

  const decoded = withBreaks.replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  )

  return decoded
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Plain text (Markdown, a ticket description) as diff lines: one per line,
 * trailing whitespace dropped, so a line that only lost a trailing space is
 * not a change. Blank lines are kept — in Markdown they separate paragraphs.
 */
export const textToLines = (text: string | null | undefined): string[] => {
  if (!text) return []
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd())
}

export type DiffLineOp =
  | { type: 'equal'; text: string }
  | { type: 'add'; text: string }
  | { type: 'remove'; text: string }

// Above this many DP cells, an O(n*m) LCS table is too slow/memory-heavy to
// build on the main thread; the changed middle is diffed with Myers instead.
const MAX_DIFF_CELLS = 4_000_000

// Myers keeps one snapshot of its frontier per edit, (d + 1)² cells in all
// (16 MB at this bound). A middle that differs in more lines than this falls
// back to "everything old removed, everything new added" rather than hanging.
const MAX_MYERS_EDITS = 2_000

/**
 * A line diff in document order; consecutive 'remove' then 'add' runs render
 * as a changed block when the caller wants that, but callers may also render
 * them plainly.
 *
 * The unchanged head and tail are trimmed first, so a one-line edit in a long
 * document diffs one line. The changed middle is diffed by LCS when its table
 * is small, and by Myers' O((n + m) · d) algorithm when it is not, so a few
 * scattered edits in a long document stay a few lines.
 */
export const computeLineDiff = (oldLines: string[], newLines: string[]): DiffLineOp[] => {
  const limit = Math.min(oldLines.length, newLines.length)
  let head = 0
  while (head < limit && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < limit - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1
  const oldMiddle = oldLines.slice(head, oldLines.length - tail)
  const newMiddle = newLines.slice(head, newLines.length - tail)
  const middle = oldMiddle.length * newMiddle.length <= MAX_DIFF_CELLS
    ? lcsLineDiff(oldMiddle, newMiddle)
    : myersLineDiff(oldMiddle, newMiddle) ?? [
        ...oldMiddle.map((text): DiffLineOp => ({ type: 'remove', text })),
        ...newMiddle.map((text): DiffLineOp => ({ type: 'add', text })),
      ]
  return [
    ...oldLines.slice(0, head).map((text): DiffLineOp => ({ type: 'equal', text })),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((text): DiffLineOp => ({ type: 'equal', text })),
  ]
}

/**
 * Myers' greedy diff: the furthest-reaching path on each diagonal, one edit
 * at a time, then walked back through the kept frontiers. Null past
 * `MAX_MYERS_EDITS` edits.
 */
const myersLineDiff = (a: readonly string[], b: readonly string[]): DiffLineOp[] | null => {
  const n = a.length
  const m = b.length
  const offset = n + m
  const frontier = new Int32Array(2 * offset + 2)
  // trace[d]: the frontier as edit d starts, for diagonals -d..d.
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(offset, MAX_MYERS_EDITS); d += 1) {
    trace.push(frontier.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d
        || (k !== d && (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0))
      let x = down ? (frontier[offset + k + 1] ?? 0) : (frontier[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      frontier[offset + k] = x
      if (x >= n && y >= m) return myersPath(a, b, trace, d)
    }
  }
  return null
}

const myersPath = (
  a: readonly string[],
  b: readonly string[],
  trace: readonly Int32Array[],
  edits: number,
): DiffLineOp[] => {
  const ops: DiffLineOp[] = []
  let x = a.length
  let y = b.length
  for (let d = edits; d > 0; d -= 1) {
    const before = trace[d]
    const at = (k: number): number => before?.[k + d] ?? 0
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const previousK = down ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      x -= 1
      y -= 1
      ops.push({ type: 'equal', text: a[x] ?? '' })
    }
    if (down) {
      y -= 1
      ops.push({ type: 'add', text: b[y] ?? '' })
    } else {
      x -= 1
      ops.push({ type: 'remove', text: a[x] ?? '' })
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    ops.push({ type: 'equal', text: a[x] ?? '' })
  }
  return ops.reverse()
}

// Classic LCS-based line diff over a table small enough to build.
const lcsLineDiff = (oldLines: readonly string[], newLines: readonly string[]): DiffLineOp[] => {
  const n = oldLines.length
  const m = newLines.length

  // lengths[i][j] = length of the LCS of oldLines[i:] and newLines[j:]. Every
  // index below is within [0, n] / [0, m] by construction (loop bounds and the
  // (n+1) x (m+1) table size); the `?? 0` / `?? ''` fallbacks exist only to
  // satisfy noUncheckedIndexedAccess and are never actually reached.
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = lengths[i]
    const nextRow = lengths[i + 1]
    if (!row || !nextRow) continue
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const lengthAt = (i: number, j: number): number => lengths[i]?.[j] ?? 0

  const ops: DiffLineOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const oldLine = oldLines[i] ?? ''
    const newLine = newLines[j] ?? ''
    if (oldLine === newLine) {
      ops.push({ type: 'equal', text: oldLine })
      i += 1
      j += 1
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      ops.push({ type: 'remove', text: oldLine })
      i += 1
    } else {
      ops.push({ type: 'add', text: newLine })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', text: oldLines[i] ?? '' })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', text: newLines[j] ?? '' })
    j += 1
  }
  return ops
}

export type LineDiffHunks = {
  /** Unified-diff hunks: `@@ -a,b +c,d @@`, then ` `, `-` and `+` lines. Empty when nothing changed. */
  text: string
  /** Lines added and removed across the whole diff, including any cut off. */
  added: number
  removed: number
  /** The hunks were cut at `maxChars`; the rest of the change is not in `text`. */
  truncated: boolean
}

type Hunk = { oldStart: number; newStart: number; ops: DiffLineOp[] }

const PREFIX: Record<DiffLineOp['type'], string> = { equal: ' ', add: '+', remove: '-' }

const commonPrefixLength = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/**
 * One line cut to `max` characters around `focus` — where it starts to differ
 * from the line it replaced — with what was cut said at either end, so a long
 * paragraph's change is shown rather than dropped with the line.
 */
const clipLine = (text: string, focus: number, max: number): string => {
  if (text.length <= max) return text
  const start = Math.max(0, Math.min(focus - Math.floor(max / 4), text.length - max))
  const end = start + max
  return `${start > 0 ? `[… ${start} characters] ` : ''}${text.slice(start, end)}`
    + `${end < text.length ? ` [${text.length - end} more characters …]` : ''}`
}

/** Where each op of a hunk should be clipped around: a replaced line pairs with its replacement. */
const clipFocus = (ops: readonly DiffLineOp[]): number[] => {
  const focus = ops.map(() => 0)
  let index = 0
  while (index < ops.length) {
    if (ops[index]?.type === 'equal') {
      index += 1
      continue
    }
    const removed: number[] = []
    const added: number[] = []
    while (index < ops.length && ops[index]?.type !== 'equal') {
      if (ops[index]?.type === 'remove') removed.push(index)
      else added.push(index)
      index += 1
    }
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
      const [left, right] = [removed[pair] ?? 0, added[pair] ?? 0]
      const at = commonPrefixLength(ops[left]?.text ?? '', ops[right]?.text ?? '')
      focus[left] = at
      focus[right] = at
    }
  }
  return focus
}

/**
 * A line diff as unified-diff hunks, each changed run with `context` unchanged
 * lines around it, cut at `maxChars` whole lines at a time. What a model or a
 * person reads is bounded however large the documents are, and `truncated`
 * says when it was cut so the reader can be told where the rest is. A line
 * longer than `maxLineChars` (a quarter of `maxChars` by default) is clipped
 * around where it changed, with a marker saying how much was cut.
 */
export const renderLineDiffHunks = (
  ops: readonly DiffLineOp[],
  options: { context?: number; maxChars: number; maxLineChars?: number },
): LineDiffHunks => {
  const context = options.context ?? 2
  const maxLineChars = options.maxLineChars ?? Math.max(200, Math.floor(options.maxChars / 4))
  const added = ops.filter((op) => op.type === 'add').length
  const removed = ops.filter((op) => op.type === 'remove').length
  const hunks: Hunk[] = []
  let oldLine = 1
  let newLine = 1
  let current: Hunk | null = null
  let trailingEqual = 0
  ops.forEach((op, index) => {
    if (op.type !== 'equal') {
      if (!current) {
        const lead = ops.slice(Math.max(0, index - context), index)
        current = { oldStart: oldLine - lead.length, newStart: newLine - lead.length, ops: [...lead] }
        hunks.push(current)
      }
      current.ops.push(op)
      trailingEqual = 0
    } else if (current) {
      // Two changes closer than twice the context share one hunk.
      const nextChange = ops.slice(index + 1, index + 1 + context * 2 - trailingEqual)
        .some((next) => next.type !== 'equal')
      if (trailingEqual < context || nextChange) {
        current.ops.push(op)
        trailingEqual += 1
      } else {
        current = null
        trailingEqual = 0
      }
    }
    if (op.type !== 'add') oldLine += 1
    if (op.type !== 'remove') newLine += 1
  })

  const lines: string[] = []
  let length = 0
  let truncated = false
  for (const hunk of hunks) {
    const oldCount = hunk.ops.filter((op) => op.type !== 'add').length
    const newCount = hunk.ops.filter((op) => op.type !== 'remove').length
    const focus = clipFocus(hunk.ops)
    const hunkLines = [
      `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`,
      ...hunk.ops.map((op, index) => `${PREFIX[op.type]}${clipLine(op.text, focus[index] ?? 0, maxLineChars)}`),
    ]
    for (const line of hunkLines) {
      if (length + line.length + 1 > options.maxChars) {
        truncated = true
        break
      }
      lines.push(line)
      length += line.length + 1
    }
    if (truncated) break
  }
  return { text: lines.join('\n'), added, removed, truncated }
}
