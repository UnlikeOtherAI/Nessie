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
  { type: 'anthropic_api_key', expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'openai_api_key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\b(?:hf|npm)_[A-Za-z0-9_-]{20,}\b/g },
  { type: 'token_assignment', expression: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { type: 'aws_access_key', expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { type: 'database_url', expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s@/]+@[^\s/]+/gi },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'token_assignment', expression: /\b(?:api[_-]?key|token|password|secret|authorization)["']?(?:\s*[=:]\s*["']?|(?:\s*[=:])?\s+bearer\s+)[^\s"'`]{12,}/gi },
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
        /^(?:api[_-]?key|token|password|secret|authorization)["']?(?:\s*[=:]\s*["']?|(?:\s*[=:])?\s+bearer\s+)/i,
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
    /^(?:api[_-]?key|token|password|secret|authorization)["']?(?:\s*[=:]\s*["']?|(?:\s*[=:])?\s+bearer\s+)(.+)$/i,
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

/**
 * A Nessie id is a UUID — every primary key in `schema.prisma` is one — so a
 * bare UUID in chat or tool output is an identifier the model needs, not a
 * credential. Redacting it would break the id resolution the system prompt
 * tells every agent to do (`channel_find`, `people_search`). A UUID used *as* a
 * credential is still caught by `token_assignment`, which reads the
 * `token:` / `api_key=` grammar around it.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A full git object name: a public identifier, not a secret. */
const GIT_OBJECT_SHAPE = /^[0-9a-f]{40}$/i

const characterClassCount = (value: string): number =>
  [/[a-z]/, /[A-Z]/, /\d/, /[_-]/].filter((expression) => expression.test(value)).length

/**
 * Credentials carrying no provider prefix, by the alphabet they are encoded in.
 *
 * Three runs rather than one, because no single alphabet covers all three
 * without either missing credentials or eating text that is not one:
 *
 * - `general` covers alphanumeric and base64url. It admits `-` so a base64url
 *   token is one run instead of `\b`-split fragments, and keeps the
 *   three-character-class rule — that rule is what stops a long camelCase
 *   identifier in source code from reading as random.
 * - `hex` is separate because hex is only ever two character classes and so can
 *   never satisfy that rule; a 50-char key went undetected for exactly that
 *   reason. Its threshold is relative to hex's own 4.0 bits-per-character
 *   ceiling rather than the shared 4.0 used for wider alphabets. A digest
 *   carrying its algorithm label (`sha256:…`) is content addressing, not a
 *   credential, and is excluded by name.
 * - `base64` is separate because `/` cannot join the general alphabet: a URL
 *   path is a long run of mixed-case, digit-bearing segments, and folding `/`
 *   in would redact every link. `+` or `=` is what a URL path does not carry,
 *   so one of them is required rather than optional.
 */
const ENTROPY_RUNS: { accept: (value: string) => boolean; expression: RegExp }[] = [
  {
    accept: (value) =>
      !UUID_SHAPE.test(value) && characterClassCount(value) >= 3 && entropy(value) >= 4,
    expression: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
  },
  {
    accept: (value) => !GIT_OBJECT_SHAPE.test(value) && entropy(value) >= 3.5,
    expression: /(?<!\b(?:sha1|sha256|sha384|sha512|md5|blake3)[:-])(?<![A-Za-z0-9_-])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9_-])/g,
  },
  {
    accept: (value) =>
      /[+=]/.test(value) && characterClassCount(value) >= 3 && entropy(value) >= 4,
    expression: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/])/g,
  },
]

/**
 * Path spans of `http(s)://…` URLs.
 *
 * A long opaque path segment is a document id — a Google Docs key, a Drive file
 * id, an S3 object key — not a credential, and masking it destroys the very
 * links the system prompt tells every agent to produce. Only the path is
 * excluded: a credential handed over *in* a URL rides in the query string, so
 * everything from `?` or `#` onwards stays in scope.
 */
const urlPathSpans = (content: string): [number, number][] => {
  const spans: [number, number][] = []
  const expression = /\bhttps?:\/\/[^\s<>"'`]+/gi
  for (let match = expression.exec(content); match; match = expression.exec(content)) {
    const queryAt = match[0].search(/[?#]/)
    spans.push([match.index, match.index + (queryAt === -1 ? match[0].length : queryAt)])
  }
  return spans
}

const highEntropyTokens = (content: string): DetectedSecret[] => {
  const candidates: DetectedSecret[] = []
  const urlPaths = urlPathSpans(content)
  for (const run of ENTROPY_RUNS) {
    run.expression.lastIndex = 0
    for (let match = run.expression.exec(content); match; match = run.expression.exec(content)) {
      const value = match[0]
      if (!run.accept(value)) continue
      if (urlPaths.some(([from, to]) => match.index >= from && match.index < to)) continue
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

/**
 * Returns non-overlapping structural matches in source order.
 *
 * Provider patterns outrank the entropy runs on an identical span: both now
 * match `sk-ant-…` end to end, and only the provider match carries the prefix
 * that names the credential in the capture form.
 */
export const detectSecrets = (content: string): DetectedSecret[] => {
  const candidates: (DetectedSecret & { priority: number })[] = []
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0
    for (let match = pattern.expression.exec(content); match; match = pattern.expression.exec(content)) {
      candidates.push({
        type: pattern.type,
        prefix: prefixFor(match[0], pattern.type),
        priority: 0,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }
  candidates.push(...highEntropyTokens(content).map((match) => ({ ...match, priority: 1 })))

  const nonOverlapping: DetectedSecret[] = []
  const ordered = candidates.sort((left, right) =>
    left.start - right.start || right.end - left.end || left.priority - right.priority)
  for (const candidate of ordered) {
    const previous = nonOverlapping.at(-1)
    if (previous && candidate.start < previous.end) continue
    const { priority: _priority, ...match } = candidate
    nonOverlapping.push(match)
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
