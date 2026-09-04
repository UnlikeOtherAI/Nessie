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

const SECRET_MASK = '•'.repeat(12)
const PROVIDER_PREFIX = new RegExp(
  '^(?:sk-(?:proj-|ant-)?|(?:sk|rk)_(?:live|test)_|github_pat_|gh[pousr]_|glpat-'
    + '|xox[a-z]-|hf_|npm_|AIza|AKIA|ASIA|ABIA|ACCA)',
)

const providerPrefixForValue = (value: string): string =>
  value.match(PROVIDER_PREFIX)?.[0] ?? ''

/**
 * Keep only the provider-identifying part of a credential visible. A generic
 * first-N mask leaks real key bytes for short prefixes (`sk_live_1234…`) and
 * can expose a database username; these prefixes stop at structural syntax.
 */
const prefixFor = (value: string, type: DetectedSecret['type']): string => {
  switch (type) {
    case 'anthropic_api_key': return value.match(/^sk-ant-/)?.[0] ?? 'sk-ant-'
    case 'aws_access_key': return value.slice(0, 4)
    case 'database_url': return value.match(/^[a-z+]+:\/\//i)?.[0] ?? ''
    case 'github_token': {
      return value.match(/^(?:github_pat_|gh[pousr]_|glpat-)/)?.[0] ?? value.slice(0, 4)
    }
    case 'high_entropy_token': return value.slice(0, 4)
    case 'jwt': return 'eyJ'
    case 'openai_api_key': return value.match(/^sk-(?:proj-)?/)?.[0] ?? 'sk-'
    case 'pem_private_key': {
      return value.match(/^-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/)?.[0] ?? ''
    }
    case 'stripe_api_key': {
      return value.match(/^(?:sk|rk)_(?:live|test)_/)?.[0] ?? value.slice(0, 3)
    }
    case 'token_assignment': {
      return value.match(
        /^(?:api[_-]?key|token|password|secret|authorization)\s*(?:=|:|\s+bearer\s+)/i,
      )?.[0] ?? providerPrefixForValue(value)
    }
  }
}

/** A display-safe value: structural provider prefix plus a fixed bullet mask. */
export const maskSecretValue = (
  value: string,
  type: DetectedSecret['type'],
): string => `${prefixFor(value, type)}${SECRET_MASK}`

/** Return only the credential bytes represented by a structural match. */
export const extractDetectedSecretValue = (
  content: string,
  detected: DetectedSecret,
): string => {
  const matched = content.slice(detected.start, detected.end)
  if (detected.type !== 'token_assignment') return matched
  return matched.match(
    /^(?:api[_-]?key|token|password|secret|authorization)\s*(?:=|:|\s+bearer\s+)\s*(.+)$/i,
  )?.[1] ?? matched
}

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
        prefix: prefixFor(value, 'high_entropy_token'),
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
        prefix: prefixFor(match[0], pattern.type),
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
    result += maskSecretValue(content.slice(match.start, match.end), match.type)
    cursor = match.end
  }
  return result + content.slice(cursor)
}
