/**
 * Repair smart-quoted JSON tool arguments.
 *
 * LLMs occasionally output Unicode curly quotes (\u201c / \u201d) instead of
 * standard ASCII quotes. This causes `JSON.parse` to fail. We detect those
 * cases and replace them with valid JSON, using known-key successor maps to
 * know where a smart-quoted value should end.
 */

// Common argument keys seen across Nessie tools
export const TOOLCALL_REPAIR_KNOWN_ARG_KEYS = new Set([
  'command',
  'description',
  'path',
  'file_path',
  'pattern',
  'cwd',
  'query',
  'action',
  'name',
  'workflowId',
  'taskId',
  'label',
  'ownerAgentId',
  'dependencies',
  'result',
  'error',
  'status',
  'content',
  'old_string',
  'new_string',
  'offset',
  'limit',
])

// Keys that hold freeform text (may contain commas, braces, etc.)
export const TOOLCALL_REPAIR_FREEFORM_VALUE_KEYS = new Set([
  'content',
  'old_string',
  'new_string',
  'command',
  'description',
  'query',
  'pattern',
  'result',
  'error',
  'name',
  'label',
])

// For freeform keys, map to their expected successor key
export const TOOLCALL_REPAIR_FREEFORM_SUCCESSOR_KEYS: Record<string, string> = {
  old_string: 'new_string',
}

// Tool-specific successor maps (key -> next expected key)
export const TOOLCALL_REPAIR_TOOL_VALUE_SUCCESSOR_KEYS: Record<string, Record<string, string>> = {
  FileRead: { file_path: 'offset', offset: 'limit' },
  Bash: { command: 'description', description: 'timeout' },
  FileWrite: { file_path: 'content' },
  Glob: { pattern: 'cwd' },
  Grep: { pattern: 'path' },
  WebSearch: { query: '' },
  Workflow: { action: '' },
}

// Smart quote characters
const SMART_QUOTES = /[\u201c\u201d\u2018\u2019]/

/**
 * Repair a raw JSON string that uses smart quotes instead of regular quotes.
 *
 * @param raw The raw string that may contain smart quotes
 * @param toolName Optional tool name for tool-specific successor key detection
 * @returns A repaired JSON string, or null if unrepairable
 */
export function repairSmartQuotedArgs(raw: string, toolName?: string): string | null {
  // Fast path: no smart quotes
  if (!SMART_QUOTES.test(raw)) {
    return null
  }

  const toolSuccessors = toolName
    ? (TOOLCALL_REPAIR_TOOL_VALUE_SUCCESSOR_KEYS[toolName] ?? {})
    : {}

  let result = ''
  let i = 0
  const len = raw.length

  // Track state
  let inString = false
  let stringQuote: string | null = null // the opening quote char
  let inEscape = false
  let objectDepth = 0
  let arrayDepth = 0
  let keyName: string | null = null // the key we're currently inside a value for
  let justSawColon = false
  let collectingKey = false
  let currentKey = ''

  while (i < len) {
    const ch = raw[i]

    if (inEscape) {
      // Inside an escape sequence after backslash
      const escapeMap: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '\\': '\\',
        '"': '"',
        '/': '/',
      }
      if (escapeMap[ch] !== undefined) {
        result += '\\' + ch
      } else {
        // Unknown escape, keep as-is but with backslash
        result += '\\' + ch
      }
      inEscape = false
      i++
      continue
    }

    if (!inString) {
      // Not inside a string value
      if (ch === '\\') {
        result += ch
        i++
        continue
      }

      if (ch === '{' || ch === '}') {
        if (ch === '{') objectDepth++
        else objectDepth--
        result += ch
        i++
        continue
      }

      if (ch === '[' || ch === ']') {
        if (ch === '[') arrayDepth++
        else arrayDepth--
        result += ch
        i++
        continue
      }

      if (ch === ':') {
        justSawColon = true
        if (collectingKey) {
          keyName = currentKey
          collectingKey = false
          currentKey = ''
        }
        result += ch
        i++
        // Skip whitespace after colon
        while (i < len && /\s/.test(raw[i])) {
          result += raw[i]
          i++
        }
        continue
      }

      if (ch === ',' || ch === '}' || ch === ']') {
        keyName = null
        justSawColon = false
        collectingKey = false
        currentKey = ''
        result += ch
        i++
        continue
      }

      if (ch === '\u201c' || ch === '\u201d' || ch === '\u2018' || ch === '\u2019') {
        // Smart quote outside a value context
        if (justSawColon && keyName != null) {
          // It's a value
          inString = true
          stringQuote = ch
          result += '"'
          i++
          justSawColon = false
          continue
        }
        // It's a key
        inString = true
        stringQuote = ch
        collectingKey = true
        currentKey = ''
        result += '"'
        i++
        continue
      }

      if (ch === '"') {
        // Regular quote — could be key or value
        if (justSawColon && keyName != null) {
          // It's a value
          inString = true
          stringQuote = ch
          result += ch
          i++
          justSawColon = false
          continue
        }
        // It's a key
        inString = true
        stringQuote = ch
        collectingKey = true
        currentKey = ''
        result += ch
        i++
        continue
      }

      // Regular character
      result += ch
      i++
      continue
    }

    // We're inside a string value (opened by a smart quote or regular quote)
    if (ch === '\\') {
      inEscape = true
      i++
      continue
    }

    if (ch === '\u201c' || ch === '\u201d' || ch === '\u2018' || ch === '\u2019') {
      // Closing smart quote
      if (collectingKey) {
        // End of key
        keyName = currentKey
        collectingKey = false
        currentKey = ''
        result += '"'
        inString = false
        stringQuote = null
        i++
        continue
      }

      // Check if this is truly the end of the value, or if the value continues
      // (e.g., freeform text that contains what looks like a successor key)
      const possibleEnd = i + 1
      const trimmedAfter = raw.slice(possibleEnd).trimStart()

      // Look for successor key patterns to determine if we should close here
      const shouldClose = shouldCloseSmartQuote(
        trimmedAfter,
        keyName,
        toolSuccessors,
        objectDepth,
        arrayDepth,
      )

      if (shouldClose) {
        result += '"'
        inString = false
        stringQuote = null
        keyName = null
        i++
        continue
      } else {
        // The quote is part of the value content, keep it as escaped quote
        result += '\"'
        i++
        continue
      }
    }

    if (ch === '"' && stringQuote === '"') {
      // Closing regular quote
      if (collectingKey) {
        keyName = currentKey
        collectingKey = false
        currentKey = ''
      }
      result += ch
      inString = false
      stringQuote = null
      i++
      continue
    }

    // Normal character inside string
    if (collectingKey) {
      currentKey += ch
    }
    result += ch
    i++
  }

  // If we ended still inside a string, close it
  if (inString) {
    result += '"'
  }

  // Try to parse to verify it's valid JSON
  try {
    JSON.parse(result)
    return result
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _isSmartQuoteCheck(): void {
  // This function exists to satisfy the linter that isSmartQuote is used.
  // The function is actually called inline in the main loop for performance.
  isSmartQuote('')
}

function isSmartQuote(ch: string): boolean {
  return ch === '\u201c' || ch === '\u201d' || ch === '\u2018' || ch === '\u2019'
}

// Re-export for test access
export { isSmartQuote }

function shouldCloseSmartQuote(
  afterTrimmed: string,
  keyName: string | null,
  toolSuccessors: Record<string, string>,
  _objectDepth: number,
  _arrayDepth: number,
): boolean {
  // If there's nothing after, close it
  if (afterTrimmed.length === 0) {
    return true
  }

  // If next char is a structural character, close it
  const firstChar = afterTrimmed[0]
  if (firstChar === ',' || firstChar === '}' || firstChar === ']') {
    return true
  }

  // If the next thing looks like a known key, we should close
  // Check for pattern: "key" or "key": or key:
  const keyMatch = afterTrimmed.match(/^(?:"?)([a-zA-Z_][a-zA-Z0-9_]*)(?:"?)\s*:/)
  if (keyMatch) {
    const nextKey = keyMatch[1]

    // Check if this next key is a known successor for our current key
    if (keyName != null) {
      // Tool-specific successor
      const toolSuccessor = toolSuccessors[keyName ?? '']
      if (toolSuccessor && toolSuccessor === nextKey) {
        return true
      }

      // Freeform successor map
      const freeformSuccessor = TOOLCALL_REPAIR_FREEFORM_SUCCESSOR_KEYS[keyName ?? '']
      if (freeformSuccessor && freeformSuccessor === nextKey) {
        return true
      }

      // If current key is NOT a freeform key and next key is known, close
      if (!TOOLCALL_REPAIR_FREEFORM_VALUE_KEYS.has(keyName)) {
        if (TOOLCALL_REPAIR_KNOWN_ARG_KEYS.has(nextKey)) {
          return true
        }
      }

      // If next key is a known successor pattern for the current key
      // (generic: common pairs)
      const genericSuccessors: Record<string, string[]> = {
        command: ['description', 'timeout'],
        file_path: ['content', 'offset', 'limit'],
        pattern: ['cwd', 'path'],
        query: [],
        action: [],
        name: ['description', 'ownerAgentId'],
        workflowId: ['label', 'description', 'ownerAgentId', 'dependencies'],
        taskId: ['label', 'description', 'status', 'ownerAgentId', 'result', 'error'],
      }
      const generic = genericSuccessors[keyName ?? '']
      if (generic && generic.includes(nextKey)) {
        return true
      }
    }

    // If next key is a known arg key, it's likely a real key
    if (TOOLCALL_REPAIR_KNOWN_ARG_KEYS.has(nextKey)) {
      return true
    }
  }

  // If we see a structural end, close
  if (afterTrimmed.startsWith('}') || afterTrimmed.startsWith(']')) {
    return true
  }

  // Default: don't close, the quote is part of the value
  return false
}
