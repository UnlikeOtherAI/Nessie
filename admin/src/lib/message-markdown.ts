export type MarkdownCodeRange = {
  end: number
  kind: 'block' | 'inline'
  start: number
}

const fence = '```'

const lineStartAt = (text: string, index: number): number =>
  text.lastIndexOf('\n', Math.max(0, index - 1)) + 1

const lineEndAt = (text: string, index: number): number => {
  const end = text.indexOf('\n', index)
  return end === -1 ? text.length : end
}

const isStandardFencePair = (
  text: string,
  openingStart: number,
  closingStart: number,
): boolean => {
  const openingIndent = text.slice(lineStartAt(text, openingStart), openingStart)
  const closingIndent = text.slice(lineStartAt(text, closingStart), closingStart)
  const closingTail = text.slice(closingStart + fence.length, lineEndAt(text, closingStart))

  return (
    /^[ \t]{0,3}$/.test(openingIndent) &&
    /^[ \t]{0,3}$/.test(closingIndent) &&
    /^[ \t]*$/.test(closingTail)
  )
}

const trimFenceBoundaryNewlines = (content: string): string => {
  let trimmed = content
  if (trimmed.startsWith('\n')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('\n')) trimmed = trimmed.slice(0, -1)
  return trimmed
}

// Standard Markdown requires a fenced block to begin at the start of a line.
// Chat authors naturally use the same delimiter inline ("before ```code```")
// and expect it to mean a block. Convert only those relaxed pairs into valid
// CommonMark while leaving ordinary fenced blocks, including language tags,
// byte-for-byte intact.
export const normalizeMessageMarkdown = (text: string): string => {
  let cursor = 0
  let output = ''

  while (cursor < text.length) {
    const openingStart = text.indexOf(fence, cursor)
    if (openingStart === -1) {
      output += text.slice(cursor)
      break
    }

    const closingStart = text.indexOf(fence, openingStart + fence.length)
    if (closingStart === -1) {
      output += text.slice(cursor)
      break
    }

    if (isStandardFencePair(text, openingStart, closingStart)) {
      output += text.slice(cursor, closingStart + fence.length)
      cursor = closingStart + fence.length
      continue
    }

    output += text.slice(cursor, openingStart)
    if (output.length > 0 && !output.endsWith('\n')) output += '\n'
    output += '\n```\n'
    output += trimFenceBoundaryNewlines(
      text.slice(openingStart + fence.length, closingStart),
    )
    output += '\n```\n\n'
    cursor = closingStart + fence.length
  }

  return output
}

// Lightweight ranges for the live editor. This deliberately highlights the
// raw delimiters too, making it clear what syntax will be submitted without
// replacing the author's Markdown with a separate rich-text document model.
export const findMarkdownCodeRanges = (text: string): MarkdownCodeRange[] => {
  const ranges: MarkdownCodeRange[] = []
  let cursor = 0

  while (cursor < text.length) {
    if (text.startsWith(fence, cursor)) {
      const closingStart = text.indexOf(fence, cursor + fence.length)
      ranges.push({
        end: closingStart === -1 ? text.length : closingStart + fence.length,
        kind: 'block',
        start: cursor,
      })
      cursor = ranges.at(-1)?.end ?? text.length
      continue
    }

    if (text[cursor] === '`') {
      const closingStart = text.indexOf('`', cursor + 1)
      if (closingStart !== -1) {
        ranges.push({ end: closingStart + 1, kind: 'inline', start: cursor })
        cursor = closingStart + 1
        continue
      }
    }

    cursor += 1
  }

  return ranges
}
