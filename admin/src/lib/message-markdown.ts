export type MarkdownCodeRange = {
  // Delimiters are reported separately from the snippet itself so the live
  // editor can conceal them without rewriting what the author will send.
  contentEnd: number
  contentStart: number
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

const appendBlock = (output: string, content: string): string => {
  const separated = output.length > 0 && !output.endsWith('\n') ? `${output}\n` : output
  return `${separated}\n${fence}\n${trimFenceBoundaryNewlines(content)}\n${fence}\n`
}

// CommonMark reads the rest of the opening line as an info string, so a lone
// language tag stays a language tag. Anything with inner whitespace is prose
// the author meant as the first line of the snippet.
const isLanguageTag = (info: string): boolean => {
  const tag = info.trim()
  return tag.length === 0 || !/\s/.test(tag)
}

// A fence left unclosed is normal while typing and survives to send. CommonMark
// runs it to the end of the document, which swallows same-line content into the
// info string and renders an empty block, so only a real block opener may stand.
const opensStandardBlock = (text: string, openingStart: number): boolean =>
  /^[ \t]{0,3}$/.test(text.slice(lineStartAt(text, openingStart), openingStart)) &&
  isLanguageTag(
    text.slice(openingStart + fence.length, lineEndAt(text, openingStart + fence.length)),
  )

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
    const contentEnd = closingStart === -1 ? text.length : closingStart

    if (closingStart === -1 && opensStandardBlock(text, openingStart)) {
      output += text.slice(cursor)
      break
    }
    if (closingStart !== -1 && isStandardFencePair(text, openingStart, closingStart)) {
      output += text.slice(cursor, closingStart + fence.length)
      cursor = closingStart + fence.length
      continue
    }

    output += text.slice(cursor, openingStart)
    output = appendBlock(output, text.slice(openingStart + fence.length, contentEnd))
    if (closingStart === -1) break
    output += '\n'
    cursor = closingStart + fence.length
  }

  return output
}

// Lightweight ranges for the live editor. The author's Markdown stays the
// document — nothing is rewritten — but knowing where the delimiters sit lets
// the editor show the snippet the way it will read once posted.
export const findMarkdownCodeRanges = (text: string): MarkdownCodeRange[] => {
  const ranges: MarkdownCodeRange[] = []
  let cursor = 0

  while (cursor < text.length) {
    if (text.startsWith(fence, cursor)) {
      const closingStart = text.indexOf(fence, cursor + fence.length)
      const contentEnd = closingStart === -1 ? text.length : closingStart
      ranges.push({
        contentEnd,
        contentStart: cursor + fence.length,
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
        ranges.push({
          contentEnd: closingStart,
          contentStart: cursor + 1,
          end: closingStart + 1,
          kind: 'inline',
          start: cursor,
        })
        cursor = closingStart + 1
        continue
      }
    }

    cursor += 1
  }

  return ranges
}
