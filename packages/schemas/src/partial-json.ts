/**
 * Incremental extraction of one top-level string field out of JSON that is
 * still being written.
 *
 * This exists because a model emits a document as the `markdown` argument of a
 * tool call, and the provider streams those arguments as raw JSON fragments.
 * To show the document as it arrives we must decode the value *before* the
 * JSON is parseable — but a viewer watching one document and a Knowledge Base
 * saving another would be worse than no streaming at all, so the scanner is a
 * real lexer with two hard invariants rather than a regex over half-written
 * text:
 *
 * - **Committed-prefix monotonicity.** Output only ever grows by appending.
 *   A half-arrived escape (`\`, three of the four `\uXXXX` digits) or a lone
 *   high surrogate at the end of the buffer is withheld until it completes, so
 *   every prefix published to a client stays a prefix of the final value. Raw
 *   text and escaped text are held back by the same rule, because a chunk
 *   boundary can split a literal emoji just as easily as an escape.
 * - **Duplicate-key rejection.** `JSON.parse` keeps the *last* of duplicated
 *   keys, so a second top-level `markdown` key could make the saved document
 *   differ from the streamed one. That fails the scan instead.
 *
 * Feed it the raw argument fragments in order; it is O(new characters).
 */

const HIGH_SURROGATE_FIRST = 0xd800
const HIGH_SURROGATE_LAST = 0xdbff

/** Completed top-level string values are kept for cheap metadata reads. */
const MAX_TRACKED_FIELD_LENGTH = 4_096

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

export type PartialJsonScanner = {
  /** Feed the next raw JSON fragment. Ignored once the scan has failed. */
  push: (fragment: string) => void
  /**
   * Decoded value of the target field so far, guaranteed to be a prefix of the
   * final value (never ends mid-escape or on a lone high surrogate).
   */
  committed: () => string
  /** Completed top-level string fields other than the target. */
  fields: () => Record<string, string>
  /** True once the target field's string value has been closed. */
  isComplete: () => boolean
  /** Non-null when the fragment stream is unusable; scanning has stopped. */
  error: () => string | null
}

type Container = 'object' | 'array'

export const createPartialJsonScanner = (targetKey: string): PartialJsonScanner => {
  const stack: Container[] = []
  const completedFields: Record<string, string> = {}

  // Raw decoded output for the target field. `committed()` trims whatever is
  // not yet safe to publish; nothing is ever removed from `raw` itself.
  let raw = ''
  let failure: string | null = null
  let complete = false

  let inString = false
  let stringIsKey = false
  // Text of the string currently being read, when it is a key or a tracked
  // top-level scalar. The target field's value never accumulates here.
  let stringBuf = ''
  let trackingString = false
  let capturing = false

  let escaping = false
  let unicodeDigits: string | null = null

  let lastKey: string | null = null
  let expectKey = false
  let nextValueIsTarget = false
  let seenTargetKey = false

  const fail = (message: string): void => {
    if (!failure) failure = message
  }

  const emit = (text: string): void => {
    if (capturing) {
      raw += text
      return
    }
    if (trackingString && stringBuf.length < MAX_TRACKED_FIELD_LENGTH) {
      stringBuf += text
    }
  }

  const openString = (): void => {
    inString = true
    escaping = false
    unicodeDigits = null
    stringBuf = ''
    const container = stack[stack.length - 1]
    stringIsKey = container === 'object' && expectKey
    if (stringIsKey) {
      trackingString = true
      capturing = false
      return
    }
    // A value string. Only the top-level target field streams; other top-level
    // strings are tracked whole so metadata (title, ids) can be read early.
    capturing = nextValueIsTarget
    trackingString = !capturing && stack.length === 1 && lastKey !== null
    nextValueIsTarget = false
  }

  const closeString = (): void => {
    inString = false
    if (stringIsKey) {
      lastKey = stringBuf
      expectKey = false
      if (stack.length === 1 && stringBuf === targetKey) {
        if (seenTargetKey) {
          fail(`Duplicate top-level "${targetKey}" key in tool arguments`)
          return
        }
        seenTargetKey = true
      }
      stringBuf = ''
      trackingString = false
      return
    }
    if (capturing) {
      capturing = false
      complete = true
      return
    }
    if (trackingString && lastKey !== null) {
      completedFields[lastKey] = stringBuf
    }
    trackingString = false
    stringBuf = ''
  }

  const pushStringChar = (char: string): void => {
    if (unicodeDigits !== null) {
      if (!/^[0-9a-fA-F]$/.test(char)) {
        fail('Malformed \\u escape in tool arguments')
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
        fail(`Invalid escape "\\${char}" in tool arguments`)
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
        stack.push('object')
        expectKey = true
        lastKey = null
        return
      case '[':
        stack.push('array')
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
      case ':':
        // Only a top-level key can name the streaming target.
        nextValueIsTarget = stack.length === 1 && lastKey === targetKey
        return
      case ',':
        if (stack[stack.length - 1] === 'object') {
          expectKey = true
          lastKey = null
        }
        return
      default:
        return
    }
  }

  return {
    push: (fragment) => {
      if (failure !== null) return
      for (const char of splitCodeUnits(fragment)) {
        if (failure !== null) return
        if (inString) {
          pushStringChar(char)
        } else {
          pushStructuralChar(char)
        }
      }
    },
    committed: () => {
      if (raw.length === 0) return raw
      const lastUnit = raw.charCodeAt(raw.length - 1)
      // Hold back a trailing high surrogate: its pair may be in the next
      // fragment, and half a pair is not a prefix of the final value.
      if (lastUnit >= HIGH_SURROGATE_FIRST && lastUnit <= HIGH_SURROGATE_LAST) {
        return raw.slice(0, -1)
      }
      return raw
    },
    fields: () => ({ ...completedFields }),
    isComplete: () => complete,
    error: () => failure,
  }
}

/**
 * Iterate UTF-16 code units, not code points: a fragment can legitimately end
 * on half a surrogate pair, and `for...of` would yield a replacement-character
 * reading of it. The pair is reassembled by plain concatenation in `emit`.
 */
function* splitCodeUnits(text: string): Generator<string> {
  for (let index = 0; index < text.length; index += 1) {
    yield text[index]!
  }
}
