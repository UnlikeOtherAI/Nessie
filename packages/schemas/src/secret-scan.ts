/**
 * Structural, deterministic secret detection shared by the composer and API.
 * It deliberately does not infer a person's intent: every match is a stable
 * credential syntax (prefix, PEM boundary, URI userinfo, or header grammar).
 */
export type DetectedSecret = {
  type:
    | 'anthropic_api_key'
    | 'aws_access_key'
    | 'database_url'
    | 'github_token'
    | 'high_entropy_token'
    | 'jwt'
    | 'openai_api_key'
    | 'pem_private_key'
    | 'stripe_api_key'
    | 'token_assignment'
  prefix: string
  start: number
  end: number
}

type SecretPattern = Omit<DetectedSecret, 'prefix' | 'start' | 'end'> & {
  expression: RegExp
}

const PATTERNS: SecretPattern[] = [
  { type: 'pem_private_key', expression: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g },
  { type: 'stripe_api_key', expression: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: 'github_token', expression: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { type: 'github_token', expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/g },
  { type: 'openai_api_key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'anthropic_api_key', expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\b(?:hf|npm)_[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { type: 'aws_access_key', expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { type: 'database_url', expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@/]+@[^\s/]+/gi },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'token_assignment', expression: /\b(?:api[_-]?key|token|password|secret|authorization)\s*(?:=|:|\s+bearer\s+)\s*[^\s"'`]{12,}/gi },
]

const prefixFor = (value: string): string => value.slice(0, Math.min(value.length, 12))

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
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /_/].filter((expression) => expression.test(value)).length
    if (classes >= 3 && entropy(value) >= 4) {
      candidates.push({
        type: 'high_entropy_token',
        prefix: prefixFor(value),
        start: match.index,
        end: match.index + value.length,
      })
    }
  }
  return candidates
}

/** Returns non-overlapping structural matches in source order. */
export const detectSecrets = (content: string): DetectedSecret[] => {
  const candidates: DetectedSecret[] = []
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0
    for (let match = pattern.expression.exec(content); match; match = pattern.expression.exec(content)) {
      candidates.push({
        type: pattern.type,
        prefix: prefixFor(match[0]),
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }
  candidates.push(...highEntropyTokens(content))

  const nonOverlapping: DetectedSecret[] = []
  for (const candidate of candidates.sort((left, right) => left.start - right.start || right.end - left.end)) {
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
    result += '••••••••••••'
    cursor = match.end
  }
  return result + content.slice(cursor)
}
