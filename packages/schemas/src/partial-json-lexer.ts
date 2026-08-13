/**
 * Incremental JSON lexer for values that are still being written.
 *
 * Extracted so the compose scanner (one top-level string) and the edit scanner
 * (a growing array of `{find, replace}` objects) share one reader rather than
 * two hand-rolled parsers whose escape handling could drift. Everything the
 * feature's correctness rests on — decoding escapes that straddle chunk
 * boundaries, never emitting half of one — lives here and is tested once.
 *
 * The lexer reports *where* it is via a path (`['edits', 0, 'replace']`), and
 * the consumer decides which values to read.
 */

export type JsonPath = readonly (string | number)[]

/** How a consumer wants to read the string value that is starting. */
export type ValueMode = 'capture' | 'ignore'

export type JsonLexerHandlers = {
  /** A string value is starting at this path. */
  beginValue: (path: JsonPath) => ValueMode
  /** Decoded text for the value currently being captured. */
  appendText: (text: string) => void
  /** The captured value's closing quote was read. */
  endValue: () => void
  /** Structurally unusable input; scanning stops. */
  fail: (message: string) => void
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

type Frame =
  | { kind: 'object'; key: string | null }
  | { kind: 'array'; index: number }

export type JsonLexer = {
  push: (fragment: string) => void
  failed: () => boolean
}

export const createJsonLexer = (handlers: JsonLexerHandlers): JsonLexer => {
  const stack: Frame[] = []

  let failed = false
  let inString = false
  let stringIsKey = false
  let keyBuffer = ''
  let capturing = false
  let escaping = false
  let unicodeDigits: string | null = null
  let expectKey = false

  const fail = (message: string): void => {
    if (failed) return
    failed = true
    handlers.fail(message)
  }

  /**
   * Path of the value about to be read: each frame contributes its current key
   * (objects) or element index (arrays).
   */
  const currentPath = (): JsonPath =>
    stack.map((frame) => (frame.kind === 'object' ? frame.key ?? '' : frame.index))

  /** A value is starting inside an array: advance that array's element index. */
  const noteValueStart = (): void => {
    const top = stack[stack.length - 1]
    if (top?.kind === 'array') {
      top.index += 1
    }
  }

  const openString = (): void => {
    inString = true
    escaping = false
    unicodeDigits = null
    const top = stack[stack.length - 1]
    stringIsKey = top?.kind === 'object' && expectKey
    if (stringIsKey) {
      keyBuffer = ''
      capturing = false
      return
    }
    noteValueStart()
    capturing = handlers.beginValue(currentPath()) === 'capture'
  }

  const closeString = (): void => {
    inString = false
    if (stringIsKey) {
      const top = stack[stack.length - 1]
      if (top?.kind === 'object') {
        top.key = keyBuffer
      }
      expectKey = false
      keyBuffer = ''
      return
    }
    if (capturing) {
      capturing = false
      handlers.endValue()
    }
  }

  const emit = (text: string): void => {
    if (stringIsKey) {
      keyBuffer += text
      return
    }
    if (capturing) {
      handlers.appendText(text)
    }
  }

  const pushStringChar = (char: string): void => {
    if (unicodeDigits !== null) {
      if (!/^[0-9a-fA-F]$/.test(char)) {
        fail('Malformed \\u escape')
        return
      }
      unicodeDigits += char
      if (unicodeDigits.length === 4) {
        emit(String.fromCharCode(Number.parseInt(unicodeDigits, 16)))
        unicodeDigits = null
      }
      return
    }

    if (escaping) {
      escaping = false
      if (char === 'u') {
        unicodeDigits = ''
        return
      }
      const decoded = SIMPLE_ESCAPES[char]
      if (decoded === undefined) {
        fail(`Invalid escape "\\${char}"`)
        return
      }
      emit(decoded)
      return
    }

    if (char === '\\') {
      escaping = true
      return
    }
    if (char === '"') {
      closeString()
      return
    }
    emit(char)
  }

  const pushStructuralChar = (char: string): void => {
    switch (char) {
      case '{':
        noteValueStart()
        stack.push({ key: null, kind: 'object' })
        expectKey = true
        return
      case '[':
        noteValueStart()
        // Starts at -1 so the first element becomes index 0.
        stack.push({ index: -1, kind: 'array' })
        expectKey = false
        return
      case '}':
      case ']':
        stack.pop()
        expectKey = false
        return
      case '"':
        openString()
        return
      case ',': {
        const top = stack[stack.length - 1]
        if (top?.kind === 'object') {
          expectKey = true
          top.key = null
        }
        return
      }
      default:
        return
    }
  }

  return {
    failed: () => failed,
    push: (fragment) => {
      if (failed) return
      // Iterate UTF-16 code units, not code points: a fragment can end on half
      // a surrogate pair, and `for...of` would read that as a replacement
      // character. The pair reassembles by plain concatenation downstream.
      for (let index = 0; index < fragment.length; index += 1) {
        if (failed) return
        const char = fragment[index]!
        if (inString) {
          pushStringChar(char)
        } else {
          pushStructuralChar(char)
        }
      }
    },
  }
}

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

/**
 * Trim a decoded buffer to what is safe to publish: never end on half a
 * surrogate pair, so every prefix a client receives stays a prefix of the
 * finished value.
 */
export const committedPrefix = (raw: string): string => {
  if (raw.length === 0) return raw
  const lastUnit = raw.charCodeAt(raw.length - 1)
  if (lastUnit >= HIGH_SURROGATE_FIRST && lastUnit <= HIGH_SURROGATE_LAST) {
    return raw.slice(0, -1)
  }
  return raw
}
