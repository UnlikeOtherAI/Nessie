import { ManifestParseError } from '../errors.js'
import { parseYamlManifest } from './yaml.js'

/**
 * Parse a Markdown manifest with YAML frontmatter into a raw JS value. The
 * body following the closing `---` delimiter is intentionally discarded — it
 * is human-readable narration only.
 *
 * The opening delimiter must be on the first line; trailing whitespace is
 * tolerated. A BOM is stripped if present.
 */
export const parseMarkdownManifest = (text: string): unknown => {
  const stripped = stripBom(text)

  const opening = matchDelimiter(stripped, 0)
  if (!opening) {
    throw new ManifestParseError(
      'md',
      'markdown manifest must start with a `---` frontmatter delimiter',
      { line: 1, column: 1 },
    )
  }

  let cursor = opening.end
  while (cursor < stripped.length) {
    const closing = findDelimiter(stripped, cursor)
    if (!closing) {
      throw new ManifestParseError(
        'md',
        'markdown manifest is missing the closing `---` frontmatter delimiter',
        { line: countLines(stripped, stripped.length), column: 1 },
      )
    }
    const frontmatter = stripped.slice(cursor, closing.start)
    try {
      return parseYamlManifest(frontmatter)
    } catch (cause) {
      if (cause instanceof ManifestParseError) {
        const offsetLine = countLines(stripped, cursor)
        throw new ManifestParseError('md', cause.message, {
          line: (cause.line ?? 1) + offsetLine,
          column: cause.column,
        })
      }
      throw cause
    }
  }

  throw new ManifestParseError(
    'md',
    'markdown manifest is missing the closing `---` frontmatter delimiter',
    { line: countLines(stripped, stripped.length), column: 1 },
  )
}

type DelimiterMatch = { start: number; end: number }

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

/**
 * Match a `---` delimiter starting at `index`. Returns the range of the
 * delimiter including the trailing newline, or `undefined` if it does not
 * match. Trailing whitespace before the newline is permitted.
 */
const matchDelimiter = (
  text: string,
  index: number,
): DelimiterMatch | undefined => {
  if (text.slice(index, index + 3) !== '---') {
    return undefined
  }
  let cursor = index + 3
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 0x0a) {
      return { start: index, end: cursor + 1 }
    }
    if (code === 0x0d) {
      const next = text.charCodeAt(cursor + 1)
      const end = next === 0x0a ? cursor + 2 : cursor + 1
      return { start: index, end }
    }
    if (code !== 0x20 && code !== 0x09) {
      return undefined
    }
    cursor += 1
  }
  // End of file immediately after the delimiter.
  return { start: index, end: cursor }
}

const findDelimiter = (
  text: string,
  startAt: number,
): DelimiterMatch | undefined => {
  let lineStart = startAt
  while (lineStart < text.length) {
    const match = matchDelimiter(text, lineStart)
    if (match) {
      return match
    }
    const newline = text.indexOf('\n', lineStart)
    if (newline === -1) {
      return undefined
    }
    lineStart = newline + 1
  }
  return undefined
}

const countLines = (text: string, upTo: number): number => {
  let count = 1
  const limit = Math.min(upTo, text.length)
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      count += 1
    }
  }
  return count
}
