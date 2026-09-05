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

/**
 * How a credential's key is actually named in the wild: an optional product
 * prefix (`OPENAI_API_KEY`), the keyword, then up to three qualifying segments
 * (`AWS_SECRET_ACCESS_KEY`). A plain `\b` in front of the keyword matched none
 * of them, because `_` is a word character.
 */
const KEY_NAME_SOURCE = '(?:[A-Za-z0-9]{1,30}[_-])?'
  + '(?:api[_-]?key|token|password|passwd|pwd|secret|authorization|credential)'
  + '(?:[_-][A-Za-z0-9]{1,30}){0,3}'

/** Separator between a key name and its value, in every shape config uses. */
const KEY_SEPARATOR_SOURCE = '["\']?(?:\\s*[=:]\\s*["\']?|(?:\\s*[=:])?\\s+bearer\\s+)'

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
  { type: 'database_url', expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/[^\s/:]+:[^\s@/]+@[^\s/]+/gi },
  { type: 'jwt', expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // A webhook URL whose secret IS its path. Structural, so these beat the
  // entropy runs and are not subject to the URL-path exclusion below.
  { type: 'token_assignment', expression: /\bhttps?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/gi },
  { type: 'token_assignment', expression: /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/gi },
  { type: 'token_assignment', expression: /(?<![A-Za-z0-9_-])(?:bot)?\d{6,}:AA[A-Za-z0-9_-]{30,}/gi },
  {
    type: 'token_assignment',
    expression: new RegExp(
      `(?<![A-Za-z0-9])${KEY_NAME_SOURCE}${KEY_SEPARATOR_SOURCE}[^\\s"'\`]{12,}`,
      'gi',
    ),
  },
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
        new RegExp(`^${KEY_NAME_SOURCE}${KEY_SEPARATOR_SOURCE}`, 'i'),
      )?.[0] ?? providerPrefixForValue(value)
    }
  }
}

/**
 * A display-safe value: structural provider prefix plus a fixed bullet mask.
 *
 * `high_entropy_token` keeps a blind first-four, which is proportionate for the
 * 32-character minimum the entropy runs enforce. A caller holding a shorter
 * value — the card capture accepts anything from twelve characters — must pass
 * `revealPrefix: false`, or a third of a twelve-character password stays
 * legible.
 */
export const maskSecretValue = (
  value: string,
  type: DetectedSecret['type'],
  options?: { revealPrefix?: boolean },
): string =>
  options?.revealPrefix === false ? SECRET_MASK : `${prefixFor(value, type)}${SECRET_MASK}`

/** Return only the credential bytes represented by a structural match. */
export const extractDetectedSecretValue = (
  content: string,
  detected: DetectedSecret,
): string => {
  const matched = content.slice(detected.start, detected.end)
  if (detected.type !== 'token_assignment') return matched
  return matched.match(
    new RegExp(`^${KEY_NAME_SOURCE}${KEY_SEPARATOR_SOURCE}(.+)$`, 'i'),
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
/**
 * Text that names an identifier rather than a credential, checked immediately
 * before a candidate. The run itself cannot tell the two apart — a digest and
 * a key are both 64 random-looking hex characters — so the label around it is
 * the only available signal. A request or trace id is the single most common
 * thing a person pastes while debugging, and masking it in the tool result the
 * agent then reads defeats the debugging it was pasted for.
 */
const IDENTIFIER_LABEL = new RegExp(
  '(?:sha(?:1|256|384|512)(?:sum)?|md5(?:sum)?|blake3|etag|checksum|digest|integrity'
  + '|(?:request|trace|span|session|correlation|commit|revision|build|run)[-_ ]?id)'
  + '["\'\\s:=_-]{0,4}$',
  'i',
)

/**
 * Prefixes that make a run an identifier this product itself emits: `sec_` is a
 * Nessie secret reference (the Secrets screen and `secretOutcomes` both show
 * it), and a hashed CSS class is everywhere in rendered markup. Both are
 * `prefix_hex`, which the general alphabet now joins into one run.
 */
const IDENTIFIER_PREFIX = /^(?:sec|ref|run|req|job|evt|msg|css|obj|txn|nessie)[_-]/i

/** A run this long is opaque enough to be a credential wherever it appears. */
const ALWAYS_CREDENTIAL_LENGTH = 48

type RunPosition = { content: string; index: number }

const precededByIdentifierLabel = (at: RunPosition): boolean =>
  IDENTIFIER_LABEL.test(at.content.slice(Math.max(0, at.index - 64), at.index))

const ENTROPY_RUNS: {
  accept: (value: string, at: RunPosition) => boolean
  expression: RegExp
}[] = [
  {
    accept: (value, at) =>
      !UUID_SHAPE.test(value)
      && !IDENTIFIER_PREFIX.test(value)
      && !precededByIdentifierLabel(at)
      && characterClassCount(value) >= 3
      && entropy(value) >= 4,
    expression: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
  },
  {
    accept: (value, at) =>
      !GIT_OBJECT_SHAPE.test(value)
      && !precededByIdentifierLabel(at)
      && entropy(value) >= 3.5,
    expression: /(?<![A-Za-z0-9_-])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9_-])/g,
  },
  {
    accept: (value, at) =>
      /[+=]/.test(value)
      && !precededByIdentifierLabel(at)
      && characterClassCount(value) >= 3
      && entropy(value) >= 4,
    expression: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/])/g,
  },
]

/**
 * Path spans of `http(s)://…` URLs whose segments are names rather than keys.
 *
 * A long opaque path segment is usually a document id — a Google Docs key, a
 * Drive file id, an S3 object key — and masking it destroys the very links the
 * system prompt tells every agent to produce. Three things are deliberately
 * NOT excluded, because in a URL they are credentials and not names: the
 * userinfo before `@`, the query string and fragment, and a run long enough to
 * be a credential wherever it sits. A webhook whose secret IS its path is
 * matched by its own structural pattern above, which never consults this list.
 */
const urlPathSpans = (content: string): [number, number][] => {
  const spans: [number, number][] = []
  const expression = /\bhttps?:\/\/[^\s<>"\'`]+/gi
  for (let match = expression.exec(content); match; match = expression.exec(content)) {
    const url = match[0]
    const authorityAt = url.indexOf('://') + 3
    const pathAt = url.indexOf('/', authorityAt)
    const userinfoAt = url.slice(authorityAt, pathAt === -1 ? url.length : pathAt).lastIndexOf('@')
    const queryAt = url.search(/[?#]/)
    spans.push([
      match.index + authorityAt + (userinfoAt === -1 ? 0 : userinfoAt + 1),
      match.index + (queryAt === -1 ? url.length : queryAt),
    ])
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
      if (!run.accept(value, { content, index: match.index })) continue
      if (
        value.length < ALWAYS_CREDENTIAL_LENGTH
        && urlPaths.some(([from, to]) => match.index >= from && match.index < to)
      ) continue
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
    nonOverlapping.push({
      type: candidate.type,
      prefix: candidate.prefix,
      start: candidate.start,
      end: candidate.end,
    })
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

/**
 * The secret rule every agent carries, on every surface that assembles a
 * system prompt — typed runs, delegated sub-agents and live voice calls alike.
 *
 * It lives here rather than in the worker because the voice prompt is built in
 * the API and must not diverge: an agent that answers one way in chat and
 * another on a call is the failure this single constant exists to prevent.
 *
 * Two sentences, carried on every turn, so the cost is paid once per prompt
 * rather than per detection. The first is the prohibition; the second is the
 * only thing an agent can usefully *do* instead, which is what turns a refusal
 * into a capture. Masked text (`sk_live_••••`) is a scanner replacement, never
 * something to echo, complete, or ask a person to resend.
 */
const SECRET_PROHIBITION = [
  'Never ask for, repeat, or put a secret in chat, a plain card input, or tool arguments;',
  'masked text (••••) is already-protected and must not be echoed or resent.',
].join(' ')

export const AGENT_SECRET_SAFETY_INSTRUCTION = [
  SECRET_PROHIBITION,
  'When a credential is needed or you spot one, call card_post with a secret block',
  '(destination vault_secret, name it e.g. STRIPE_API_KEY) so it goes straight to Secrets.',
].join(' ')

/**
 * The same rule for a live call, which has no `card_post`: its tools are
 * web_search, conversation_history and pa_send. Naming a tool the model cannot
 * call is worse than naming none — it resolves the contradiction by inventing
 * the capability or by asking the person to read the secret out loud.
 */
export const VOICE_SECRET_SAFETY_INSTRUCTION = [
  SECRET_PROHIBITION,
  'Never ask anyone to read a credential aloud; hand the task to your longer-running',
  'work with pa_send, which can raise a secure form in the chat, and say you have done so.',
].join(' ')
