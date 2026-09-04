/**
 * Structural, deterministic secret detection shared by every chat boundary.
 * It never guesses intent: matches come from credential syntax, provider
 * prefixes, PEM armor, URI userinfo, assignment keys, or a bounded entropy
 * fallback.
 */
export type DetectedSecret = {
  type:
    | 'anthropic_api_key'
    | 'aws_access_key'
    | 'database_url'
    | 'github_token'
    | 'google_api_key'
    | 'high_entropy_token'
    | 'jwt'
    | 'openai_api_key'
    | 'pem_private_key'
    | 'sendgrid_api_key'
    | 'slack_token'
    | 'stripe_api_key'
    | 'token_assignment'
  prefix: string
  start: number
  end: number
}

type SecretPattern = Omit<DetectedSecret, 'prefix' | 'start' | 'end'> & {
  expression: RegExp
  stripTrailingPunctuation?: boolean
  valueGroup?: number
}

/** Kept compact because this is injected into every typed and voice agent. */
export const AGENT_SECRET_SAFETY_INSTRUCTION =
  'Never request, repeat, or put secrets in chat or model-visible tool arguments; '
  + 'secure typed capture masks detected values before chat reaches you.'

const ASSIGNMENT_KEY = [
  'api[\\s_-]?key',
  'access[\\s_-]?token',
  'auth[\\s_-]?token',
  'authorization',
  'aws[\\s_-]?secret[\\s_-]?access[\\s_-]?key',
  'client[\\s_-]?secret',
  'credential',
  'pass',
  'passwd',
  'password',
  'pwd',
  'private[\\s_-]?key',
  'refresh[\\s_-]?token',
  'session[\\s_-]?token',
  'secret[\\s_-]?access[\\s_-]?key',
  'secret[\\s_-]?key',
  'signing[\\s_-]?secret',
  'passphrase',
  'secret',
  'token',
].join('|')

const AUTH_SCHEME = String.raw`(?:bearer|basic|token|api[_-]?key|digest)`
const ASSIGNMENT_SEPARATOR = String.raw`(?:\s*(?:=|:)\s*${AUTH_SCHEME}\s+|\s*(?:=|:)\s*(?!${AUTH_SCHEME}\b)|\s+${AUTH_SCHEME}\s+)`

const assignmentExpression = (value: string): RegExp =>
  new RegExp(
    String.raw`\b(?:[a-z0-9]+[_-])*[a-z0-9]*(?:${ASSIGNMENT_KEY})(?:\\?["'\x60])?${ASSIGNMENT_SEPARATOR}(?:\[\s*)?${value}`,
    'gi',
  )

const LABELED_WHITESPACE_KEY = [
  'api[\\s_-]?key',
  'access[\\s_-]?token',
  'auth[\\s_-]?token',
  'client[\\s_-]?secret',
  'pass',
  'passwd',
  'password',
  'pwd',
  'secret[\\s_-]?key',
].join('|')

const PRIVATE_KEY_BLOCK = new RegExp(
  '-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY| PGP PRIVATE KEY BLOCK)-----'
    + '[\\s\\S]*?'
    + '-----END(?: (?:[A-Z0-9]+ )?PRIVATE KEY| PGP PRIVATE KEY BLOCK)-----',
  'gi',
)

const completePrivateKeyEnds = (content: string): Map<number, number> => {
  const ends = new Map<number, number>()
  const scan = new RegExp(PRIVATE_KEY_BLOCK.source, PRIVATE_KEY_BLOCK.flags)
  for (let match = scan.exec(content); match; match = scan.exec(content)) {
    ends.set(match.index, match.index + match[0].length)
  }
  return ends
}

const PRIVATE_KEY_BEGIN = new RegExp(
  '-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY| PGP PRIVATE KEY BLOCK)-----',
  'gi',
)
const SECRET_MASK = '•'.repeat(12)
export const REDACTED_SECRET_MARKER = '[REDACTED_SECRET]'
const SAFE_REDACTION_MARKERS = new Set(['[MaxDepth]', '[REDACTED]', '[REDACTED_SECRET]'])
const SAFE_MASK_END = String.raw`["'\x60)\]},;.]*`
const SAFE_MASKED_VALUE = String.raw`(?:[A-Za-z_][A-Za-z0-9_.-]{0,119}\s*[:=]\s*)?`
  + String.raw`(?:[A-Za-z0-9]{1,16}[-_.])?${SECRET_MASK}${SAFE_MASK_END}`
const SAFE_MASK_SUFFIX = String.raw`${SAFE_MASK_END}\s*(?:${SAFE_MASKED_VALUE}\s*)*$`

/**
 * A legitimate redaction is exactly the armor header plus the fixed mask.
 * Non-whitespace on that same line, or a following base64-looking body line,
 * means raw key material was appended to a safe-looking prefix.
 */
const maskedPrivateKeyHasRawTail = (content: string, beginEnd: number): boolean => {
  if (!content.startsWith(SECRET_MASK, beginEnd)) return false
  const tail = content.slice(beginEnd + SECRET_MASK.length)
  return /^[^\s]/u.test(tail)
    || /^[ \t]*(?:[A-Za-z0-9+/_=-]{16,})[ \t]*\r?$/mu.test(tail)
}
const DATABASE_URL = new RegExp(
  '\\b(?:https?|amqps?|ldaps?|neo4j|bolt|postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|sqlserver):\\/\\/'
    + '[^\\s/:]+:[^\\s@]+@[^\\s"\'\\x60]+',
  'gi',
)
const PATTERNS: SecretPattern[] = [
  {
    // A mask is a terminal display placeholder, not trusted provenance. Apart
    // from a structural sequence of other mask-only values, later bytes could
    // be camouflage. Fail closed through the end so redaction reaches a stable
    // mask-only suffix before any sink sees it.
    type: 'token_assignment',
    expression: new RegExp(
      `${SECRET_MASK}(?!${SAFE_MASK_SUFFIX})[\\s\\S]+`,
      'g',
    ),
  },
  {
    type: 'pem_private_key',
    expression: PRIVATE_KEY_BLOCK,
  },
  { type: 'stripe_api_key', expression: /\b(?:(?:sk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9]{8,}\b/g },
  { type: 'github_token', expression: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g },
  { type: 'github_token', expression: /\bglpat-[A-Za-z0-9_-]{8,}\b/g },
  { type: 'sendgrid_api_key', expression: /\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    type: 'slack_token',
    expression: /\b(?:xox[a-z](?:-[A-Za-z0-9-]{8,}|\.[A-Za-z0-9.-]{8,})|xapp-[A-Za-z0-9-]{8,})\b/gi,
  },
  // Provider prefixes remain sensitive even when a paste was truncated. Eight
  // bytes after an unambiguous credential prefix is enough to fail closed.
  { type: 'anthropic_api_key', expression: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g },
  { type: 'openai_api_key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g },
  { type: 'token_assignment', expression: /\b(?:hf|npm)_[A-Za-z0-9_-]{8,}\b/g },
  { type: 'google_api_key', expression: /\bAIza[A-Za-z0-9_-]{8,}\b/g },
  { type: 'aws_access_key', expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { type: 'database_url', expression: DATABASE_URL, stripTrailingPunctuation: true },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    // Shell snippets and chat frequently omit `=`. Requiring a strong label
    // plus a mixed alphanumeric token avoids turning ordinary "token budget"
    // prose into a credential match.
    type: 'token_assignment',
    expression: new RegExp(
      String.raw`\b(?:${LABELED_WHITESPACE_KEY})\s+((?=[A-Za-z0-9_./+=-]*[A-Za-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]{6,})`,
      'gi',
    ),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\\"([^"\\\r\n]+)\\"`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\\'([^'\\\r\n]+)\\'`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\$?"((?:\\.|[^"\r\n])+)"`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\$?'((?:\\.|[^'\r\n])+)'`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\x60([^\x60\r\n]+)\x60`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\$\{([^}\r\n]+)\}`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(
      String.raw`(?:\(|\[|\{)?((?!\\["'\x60]|\$[{'"\x60])[^\s"'\x60([{]+)`,
    ),
    stripTrailingPunctuation: true,
    valueGroup: 1,
  },
]

const PROVIDER_PREFIX = new RegExp(
  '^(?:sk-(?:proj-|ant-)?|(?:sk|rk)_(?:live|test)_|github_pat_|gh[pousr]_|glpat-'
    + '|SG\\.|xox[a-z](?:-|\\.)|xapp-|hf_|npm_|AIza|AKIA|ASIA|ABIA|ACCA)',
  'i',
)

const providerPrefixForValue = (value: string): string =>
  value.match(PROVIDER_PREFIX)?.[0] ?? ''
/** Keep only provider syntax visible; never preserve bytes from an opaque key. */
const prefixFor = (value: string, type: DetectedSecret['type']): string => {
  switch (type) {
    case 'anthropic_api_key': return 'sk-ant-'
    case 'aws_access_key': return value.slice(0, 4)
    case 'database_url': return value.match(/^[a-z+]+:\/\//i)?.[0] ?? ''
    case 'github_token': return value.match(/^(?:github_pat_|gh[pousr]_|glpat-)/)?.[0] ?? ''
    case 'google_api_key': return 'AIza'
    case 'high_entropy_token': return ''
    case 'jwt': return 'eyJ'
    case 'openai_api_key': return value.match(/^sk-(?:proj-)?/)?.[0] ?? 'sk-'
    case 'pem_private_key': {
      return value.match(/^-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY| PGP PRIVATE KEY BLOCK)-----/i)?.[0] ?? ''
    }
    case 'sendgrid_api_key': return 'SG.'
    case 'slack_token': return value.match(/^(?:xox[a-z](?:-|\.)|xapp-)/i)?.[0] ?? 'xox-'
    case 'stripe_api_key': return value.match(/^(?:(?:sk|rk)_(?:live|test)_|whsec_)/)?.[0] ?? ''
    case 'token_assignment': return providerPrefixForValue(value)
  }
}

/** A display-safe value: structural provider prefix plus a fixed bullet mask. */
export const maskSecretValue = (
  value: string,
  type: DetectedSecret['type'],
): string => `${prefixFor(value, type)}${SECRET_MASK}`
/** The match range is always the credential itself, never its assignment syntax. */
export const extractDetectedSecretValue = (
  content: string,
  detected: DetectedSecret,
): string => content.slice(detected.start, detected.end)

const entropy = (value: string): number => {
  const frequencies = new Map<string, number>()
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  return [...frequencies.values()].reduce((sum, count) => {
    const probability = count / value.length
    return sum - probability * Math.log2(probability)
  }, 0)
}

const highEntropyTokens = (content: string): DetectedSecret[] => {
  const candidates: DetectedSecret[] = []
  const expression = /[A-Za-z0-9_+/-]{32,}={0,2}/g
  for (let match = expression.exec(content); match; match = expression.exec(content)) {
    const value = match[0]
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_+/=-]/]
      .filter((candidate) => candidate.test(value)).length
    if (classes >= 2 && entropy(value) >= 4) {
      candidates.push({
        type: 'high_entropy_token',
        prefix: '',
        start: match.index,
        end: match.index + value.length,
      })
    }
  }
  return candidates
}

const trailingPunctuationLength = (value: string): number =>
  value.match(/[,;.)\]}]+$/)?.[0].length ?? 0

/** Returns non-overlapping structural matches in source order. */
export const detectSecrets = (content: string): DetectedSecret[] => {
  const candidates: DetectedSecret[] = []
  const safeMarkerRanges: Array<{ end: number; start: number }> = []
  for (const marker of SAFE_REDACTION_MARKERS) {
    for (let start = content.indexOf(marker); start >= 0; start = content.indexOf(marker, start + 1)) {
      safeMarkerRanges.push({ start, end: start + marker.length })
    }
  }
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0
    for (let match = pattern.expression.exec(content); match; match = pattern.expression.exec(content)) {
      const value = pattern.valueGroup ? match[pattern.valueGroup] : match[0]
      if (!value) continue
      const relativeStart = pattern.valueGroup ? match[0].lastIndexOf(value) : 0
      const stripped = pattern.stripTrailingPunctuation
        ? trailingPunctuationLength(value)
        : 0
      const start = match.index + relativeStart
      const end = start + value.length - stripped
      if (end <= start) continue
      const exactValue = content.slice(start, end)
      if (
        SAFE_REDACTION_MARKERS.has(exactValue)
        || safeMarkerRanges.some((range) => start >= range.start && end <= range.end)
      ) continue
      if (
        pattern.type === 'token_assignment'
        && exactValue === `${providerPrefixForValue(exactValue)}${SECRET_MASK}`
      ) continue
      if (
        pattern.type === 'token_assignment'
        && providerPrefixForValue(exactValue) === exactValue
      ) continue
      candidates.push({
        type: pattern.type,
        prefix: prefixFor(exactValue, pattern.type),
        start,
        end,
      })
    }
  }
  // A truncated private-key paste is still credential material. Complete
  // blocks above win by range; an unmatched BEGIN marker fails closed through
  // the end of the input so neither persistence nor stream finalization can
  // expose the partial body.
  const privateKeyBeginScan = new RegExp(PRIVATE_KEY_BEGIN.source, PRIVATE_KEY_BEGIN.flags)
  for (
    let begin = privateKeyBeginScan.exec(content);
    begin;
    begin = privateKeyBeginScan.exec(content)
  ) {
    const beginEnd = begin.index + begin[0].length
    if (
      content.startsWith(SECRET_MASK, beginEnd)
      && !maskedPrivateKeyHasRawTail(content, beginEnd)
    ) continue
    const complete = candidates.some(
      (candidate) => candidate.type === 'pem_private_key' && candidate.start === begin!.index,
    )
    if (!complete) {
      candidates.push({
        type: 'pem_private_key',
        prefix: prefixFor(begin[0], 'pem_private_key'),
        start: begin.index,
        end: content.length,
      })
    }
  }
  candidates.push(...highEntropyTokens(content).filter(
    (candidate) => !safeMarkerRanges.some(
      (range) => candidate.start >= range.start && candidate.end <= range.end,
    ),
  ))

  const nonOverlapping: DetectedSecret[] = []
  for (const candidate of candidates.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    const previous = nonOverlapping.at(-1)
    if (!previous || candidate.start >= previous.end) nonOverlapping.push(candidate)
  }
  return nonOverlapping
}

/** Scan JSON-like input one string at a time, before serialization can escape boundaries. */
export const containsDetectedSecret = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return true
  if (typeof value === 'string') return detectSecrets(value).length > 0
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((entry) => containsDetectedSecret(entry, depth + 1))
  }
  return Object.values(value as Record<string, unknown>)
    .some((entry) => containsDetectedSecret(entry, depth + 1))
}

const redactDetectedSecretsOnce = (content: string): string => {
  const matches = detectSecrets(content)
  if (matches.length === 0) return content
  let cursor = 0
  let result = ''
  for (const match of matches) {
    result += content.slice(cursor, match.start)
    // Inline redactions must be stable when another defence-in-depth sink
    // scans them again. Provider prefixes plus bullets are rendered separately
    // by the capture UI; placing a bullet mask before ordinary prose is
    // indistinguishable from user-supplied mask camouflage on a later pass.
    result += REDACTED_SECRET_MARKER
    cursor = match.end
  }
  return result + content.slice(cursor)
}

/** Redaction is a fixed point: its own placeholders can never camouflage a tail. */
export const redactDetectedSecrets = (content: string): string => {
  let safe = content
  for (let pass = 0; pass < 3; pass++) {
    const next = redactDetectedSecretsOnce(safe)
    if (next === safe) return safe
    safe = next
  }
  return safe
}

/** Recursively redact string leaves before JSON-like provider data reaches a sink. */
export const redactDetectedSecretsInValue = (value: unknown, depth = 0): unknown => {
  if (depth > 16) return '[MaxDepth]'
  if (typeof value === 'string') return redactDetectedSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => redactDetectedSecretsInValue(entry, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, redactDetectedSecretsInValue(entry, depth + 1)]),
  )
}

/**
 * Redacts streamed model text without exposing a token split across deltas.
 * Complete lines may flow immediately; an unfinished line (or PEM block) is
 * retained until enough syntax exists to make the redaction decision.
 */
export const createSecretRedactingStream = (): {
  finish: () => string
  push: (chunk: string) => string
} => {
  let buffer = ''
  let outputClosedAfterCamouflage = false

  const redactStreamContent = (content: string): string => {
    if (outputClosedAfterCamouflage) return ''
    const closesOutput = detectSecrets(content).some(
      (match) => content.startsWith(SECRET_MASK, match.start),
    )
    const safe = redactDetectedSecrets(content)
    if (closesOutput) outputClosedAfterCamouflage = true
    return safe
  }

  const safeCut = (): number => {
    let cut = buffer.lastIndexOf('\n') + 1
    if (cut === 0) return 0
    const completeKeys = completePrivateKeyEnds(buffer)
    PRIVATE_KEY_BEGIN.lastIndex = 0
    for (let begin = PRIVATE_KEY_BEGIN.exec(buffer); begin; begin = PRIVATE_KEY_BEGIN.exec(buffer)) {
      if (begin.index >= cut) break
      const beginEnd = begin.index + begin[0].length
      if (buffer.startsWith(SECRET_MASK, beginEnd)) {
        const tail = buffer.slice(beginEnd + SECRET_MASK.length, cut)
        const firstCompleteLine = tail.split(/\r?\n/u).find((line) => line.trim())
        if (
          firstCompleteLine === undefined
          || maskedPrivateKeyHasRawTail(buffer.slice(0, cut), beginEnd)
        ) {
          // Hold through blank/comment/metadata lines until one complete,
          // clearly non-key line proves the masked placeholder is finished.
          cut = begin.index
          break
        }
        continue
      }
      const completeEnd = completeKeys.get(begin.index)
      if (completeEnd === undefined || completeEnd > cut) {
        cut = begin.index
        break
      }
    }
    const complete = buffer.slice(0, cut)
    const lastMask = complete.lastIndexOf(SECRET_MASK)
    if (lastMask >= 0) {
      const tail = complete.slice(lastMask + SECRET_MASK.length)
      const firstCompleteLine = tail.split(/\r?\n/u).find((line) => line.trim())
      if (firstCompleteLine === undefined) {
        // Retain a terminal mask and one following complete non-empty line so
        // a newline cannot split camouflage across two independently safe cuts.
        cut = Math.min(cut, complete.lastIndexOf('\n', lastMask - 1) + 1)
      }
    }
    return cut
  }

  return {
    finish: () => {
      const safe = redactStreamContent(buffer)
      buffer = ''
      return safe
    },
    push: (chunk) => {
      buffer += chunk
      const cut = safeCut()
      if (cut === 0) return ''
      const safe = redactStreamContent(buffer.slice(0, cut))
      buffer = buffer.slice(cut)
      return safe
    },
  }
}
