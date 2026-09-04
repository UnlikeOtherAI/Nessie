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

const ASSIGNMENT_KEY = [
  'api[_-]?key',
  'access[_-]?token',
  'auth[_-]?token',
  'authorization',
  'aws[_-]?secret[_-]?access[_-]?key',
  'client[_-]?secret',
  'credential',
  'password',
  'private[_-]?key',
  'refresh[_-]?token',
  'secret[_-]?access[_-]?key',
  'signing[_-]?secret',
  'secret',
  'token',
].join('|')

const ASSIGNMENT_SEPARATOR = String.raw`(?:\s*(?:=|:)\s*(?:bearer\s+)?|\s+bearer\s+)`

const assignmentExpression = (value: string): RegExp =>
  new RegExp(String.raw`\b(?:${ASSIGNMENT_KEY})${ASSIGNMENT_SEPARATOR}${value}`, 'gi')

const PRIVATE_KEY_BLOCK = new RegExp(
  '-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----'
    + '[\\s\\S]*?'
    + '-----END(?: (?:[A-Z0-9]+ )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----',
  'gi',
)

const DATABASE_URL = new RegExp(
  '\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|sqlserver):\\/\\/'
    + '[^\\s/:]+:[^\\s@/]+@[^\\s/]+',
  'gi',
)

const PATTERNS: SecretPattern[] = [
  {
    type: 'pem_private_key',
    expression: PRIVATE_KEY_BLOCK,
  },
  { type: 'stripe_api_key', expression: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: 'github_token', expression: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { type: 'github_token', expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'sendgrid_api_key', expression: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{32,}\b/g },
  { type: 'slack_token', expression: /\bxox[a-z](?:-[A-Za-z0-9-]{20,}|\.[A-Za-z0-9.-]{20,})\b/gi },
  { type: 'anthropic_api_key', expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'openai_api_key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\b(?:hf|npm)_[A-Za-z0-9_-]{20,}\b/g },
  { type: 'google_api_key', expression: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { type: 'aws_access_key', expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { type: 'database_url', expression: DATABASE_URL },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`"([^"\r\n•]{12,})"`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`'([^'\r\n•]{12,})'`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`\x60([^\x60\r\n•]{12,})\x60`),
    valueGroup: 1,
  },
  {
    type: 'token_assignment',
    expression: assignmentExpression(String.raw`([^\s"'\x60•]{12,})`),
    stripTrailingPunctuation: true,
    valueGroup: 1,
  },
]

const SECRET_MASK = '•'.repeat(12)
const PROVIDER_PREFIX = new RegExp(
  '^(?:sk-(?:proj-|ant-)?|(?:sk|rk)_(?:live|test)_|github_pat_|gh[pousr]_|glpat-'
    + '|SG\\.|xox[a-z](?:-|\\.)|hf_|npm_|AIza|AKIA|ASIA|ABIA|ACCA)',
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
      return value.match(/^-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i)?.[0] ?? ''
    }
    case 'sendgrid_api_key': return 'SG.'
    case 'slack_token': return value.match(/^xox[a-z](?:-|\.)/i)?.[0] ?? 'xox-'
    case 'stripe_api_key': return value.match(/^(?:sk|rk)_(?:live|test)_/)?.[0] ?? ''
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
  const expression = /\b[A-Za-z0-9_]{32,}\b/g
  for (let match = expression.exec(content); match; match = expression.exec(content)) {
    const value = match[0]
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /_/]
      .filter((candidate) => candidate.test(value)).length
    if (classes >= 3 && entropy(value) >= 4) {
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
      candidates.push({
        type: pattern.type,
        prefix: prefixFor(exactValue, pattern.type),
        start,
        end,
      })
    }
  }
  candidates.push(...highEntropyTokens(content))

  const nonOverlapping: DetectedSecret[] = []
  for (const candidate of candidates.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    const previous = nonOverlapping.at(-1)
    if (!previous || candidate.start >= previous.end) nonOverlapping.push(candidate)
  }
  return nonOverlapping
}

export const redactDetectedSecrets = (content: string): string => {
  const matches = detectSecrets(content)
  if (matches.length === 0) return content
  let cursor = 0
  let result = ''
  for (const match of matches) {
    result += content.slice(cursor, match.start)
    result += maskSecretValue(content.slice(match.start, match.end), match.type)
    cursor = match.end
  }
  return result + content.slice(cursor)
}

const PRIVATE_KEY_BEGIN = new RegExp(
  '-----BEGIN(?: (?:[A-Z0-9]+ )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----',
  'gi',
)

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

  const safeCut = (): number => {
    let cut = buffer.lastIndexOf('\n') + 1
    if (cut === 0) return 0
    PRIVATE_KEY_BEGIN.lastIndex = 0
    for (let begin = PRIVATE_KEY_BEGIN.exec(buffer); begin; begin = PRIVATE_KEY_BEGIN.exec(buffer)) {
      if (begin.index >= cut) break
      const complete = detectSecrets(buffer).find(
        (match) => match.type === 'pem_private_key' && match.start === begin.index,
      )
      if (!complete || complete.end > cut) {
        cut = begin.index
        break
      }
    }
    return cut
  }

  return {
    finish: () => {
      const safe = redactDetectedSecrets(buffer)
      buffer = ''
      return safe
    },
    push: (chunk) => {
      buffer += chunk
      const cut = safeCut()
      if (cut === 0) return ''
      const safe = redactDetectedSecrets(buffer.slice(0, cut))
      buffer = buffer.slice(cut)
      return safe
    },
  }
}
