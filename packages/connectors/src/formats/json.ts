import { ManifestParseError } from '../errors.js'

/**
 * Parse a JSON manifest string into a raw JS value. Errors are wrapped in
 * `ManifestParseError` with 1-indexed line/column when V8 reports them.
 */
export const parseJsonManifest = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const location = extractJsonLocation(text, cause)
    throw new ManifestParseError('json', message, location)
  }
}

const extractJsonLocation = (
  text: string,
  cause: unknown,
): { line?: number; column?: number } | undefined => {
  if (!(cause instanceof SyntaxError)) {
    return undefined
  }

  // V8 messages look like "... at position 42 (line 3 column 5)".
  const lineColMatch = /line (\d+) column (\d+)/.exec(cause.message)
  if (lineColMatch) {
    return {
      line: Number(lineColMatch[1]),
      column: Number(lineColMatch[2]),
    }
  }

  const positionMatch = /at position (\d+)/.exec(cause.message)
  if (!positionMatch) {
    return undefined
  }

  const position = Number(positionMatch[1])
  return positionToLineColumn(text, position)
}

const positionToLineColumn = (
  text: string,
  position: number,
): { line: number; column: number } => {
  const clamped = Math.max(0, Math.min(position, text.length))
  let line = 1
  let column = 1
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}
