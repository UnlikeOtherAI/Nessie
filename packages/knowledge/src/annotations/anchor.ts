import type { TextQuoteAnchor } from './types.js'

export type { TextQuoteAnchor } from './types.js'

// Default amount of surrounding context captured on each side of a note's quote.
export const ANCHOR_CONTEXT_LENGTH = 32

const BLOCK_BOUNDARY = /<\/(p|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/gi
const TAG = /<[^>]+>/g

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

const decodeEntities = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)

// Canonical plain-text projection of stored page HTML. Block-closing tags become
// newlines so the projection mirrors how the reader renders text, then all other
// tags are stripped and entities decoded. Must stay deterministic so the server
// (anchor capture) and the admin (relocation) agree on quote positions.
export const htmlToPlainText = (html: string): string => {
  if (!html) return ''
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(BLOCK_BOUNDARY, '\n')
      .replace(TAG, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Build an anchor from a known selection offset. Falls back to the first
// occurrence of the quote when the offset does not line up; returns null when the
// quote is absent from the text.
export const computeAnchor = (
  plainText: string,
  quote: string,
  startOffset: number,
  contextLength: number = ANCHOR_CONTEXT_LENGTH,
): TextQuoteAnchor | null => {
  if (!quote) return null
  let offset = startOffset
  if (plainText.slice(offset, offset + quote.length) !== quote) {
    offset = plainText.indexOf(quote)
    if (offset < 0) return null
  }
  return {
    quote,
    prefix: plainText.slice(Math.max(0, offset - contextLength), offset),
    suffix: plainText.slice(offset + quote.length, offset + quote.length + contextLength),
    startOffset: offset,
  }
}

const collectOccurrences = (haystack: string, needle: string): number[] => {
  const out: number[] = []
  if (!needle) return out
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

const contextScore = (plainText: string, idx: number, anchor: TextQuoteAnchor): number => {
  const before = plainText.slice(Math.max(0, idx - anchor.prefix.length), idx)
  const after = plainText.slice(idx + anchor.quote.length, idx + anchor.quote.length + anchor.suffix.length)
  let score = 0
  if (anchor.prefix && before.endsWith(anchor.prefix)) score += 2
  if (anchor.suffix && after.startsWith(anchor.suffix)) score += 2
  return score
}

// Re-locate a note's quote in the current body projection. Prefers the
// occurrence whose surrounding context matches, tie-breaking by nearest original
// offset. Returns null when the quote is gone (the note is orphaned).
export const relocateAnchor = (
  plainText: string,
  anchor: TextQuoteAnchor,
): { start: number; end: number } | null => {
  const occurrences = collectOccurrences(plainText, anchor.quote)
  let best: number | null = null
  let bestScore = -1
  for (const idx of occurrences) {
    const score = contextScore(plainText, idx, anchor)
    const closer =
      best === null || Math.abs(idx - anchor.startOffset) < Math.abs(best - anchor.startOffset)
    if (best === null || score > bestScore || (score === bestScore && closer)) {
      best = idx
      bestScore = score
    }
  }
  if (best === null) return null
  return { start: best, end: best + anchor.quote.length }
}
