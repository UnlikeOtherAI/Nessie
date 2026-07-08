// Pure line-diff utilities for comparing two HTML page bodies as plain text.
// Used by the knowledge-base draft review panel to show reviewers what an
// agent-authored draft changed relative to the currently published version.

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

export type DiffLineOp =
  | { type: 'equal'; text: string }
  | { type: 'add'; text: string }
  | { type: 'remove'; text: string }

// Above this many DP cells, an O(n*m) LCS table is too slow/memory-heavy to
// build on the main thread. Fall back to a coarse "everything old removed,
// everything new added" view rather than hanging the tab.
const MAX_DIFF_CELLS = 4_000_000

// Classic LCS-based line diff (patience-diff-adjacent, not Myers, but linear
// in the common case and simple to verify). Returns a flat list of ops in
// document order; consecutive 'remove' then 'add' runs render as a changed
// block when the caller wants that, but callers may also render them plainly.
export const computeLineDiff = (oldLines: string[], newLines: string[]): DiffLineOp[] => {
  const n = oldLines.length
  const m = newLines.length

  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...oldLines.map((text): DiffLineOp => ({ type: 'remove', text })),
      ...newLines.map((text): DiffLineOp => ({ type: 'add', text })),
    ]
  }

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
