/**
 * Email-domain normalisation and classification for automatic team access
 * (`docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md` §6).
 *
 * Pure — no I/O, no Prisma, no fetch — because the api routes, the worker jobs
 * and the tests all have to reach the same verdict. A domain that reaches a
 * grant is normalised once, stored, and every later DNS lookup and every later
 * match is built from that stored value. Never re-derive from raw input: UTS-46
 * folds full-width and confusable forms into ASCII, so checking one string and
 * using another is a check-vs-use mismatch waiting to happen.
 *
 * The classifier is deliberately small. DNS TXT proof is what actually gates
 * the feature — nobody publishes a verification record under `gmail.com` — so
 * the consumer list exists to refuse the obvious mistake early and legibly,
 * not to carry the security. It lives in this file rather than in a vendored
 * community feed so that every entry is in the diff and reviewable.
 */

/**
 * IDNA/UTS-46 folding to ASCII, via the WHATWG `URL` parser.
 *
 * Node's `domainToASCII` would be the obvious choice and is not usable here:
 * this package is also consumed by `@nessie/client-core`, which targets the
 * browser and has no `node:` module resolution at all. `new URL()` performs the
 * same UTS-46 mapping in both runtimes, so one implementation serves the api,
 * the worker and the admin — which matters, because a domain accepted at claim
 * time and folded differently at grant time is a check-vs-use mismatch.
 *
 * The caller has already rejected `@`, `/`, `:`, `?`, `#`, backslashes and
 * whitespace, so the parser cannot be handed userinfo, a port or a path here.
 */
const toAsciiDomain = (value: string): string => {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return ''
  }
}

/** Why a domain may not be used for automatic team access. */
export type DomainRejection =
  | 'malformed'
  | 'ip_literal'
  | 'localhost'
  | 'public_suffix'
  | 'single_label'
  | 'too_long'
  | 'consumer_provider'

export type DomainDecision =
  | { ok: true; domain: string }
  | { ok: false; reason: DomainRejection }

/** DNS limits: 253 octets for a name, 63 for one label. */
const MAX_DOMAIN_LENGTH = 253
const MAX_LABEL_LENGTH = 63

/**
 * Consumer and throwaway mailbox providers, refused because one person
 * controlling `example@gmail.com` is not evidence about anybody else at
 * `gmail.com`. Hand-maintained and alphabetical; a missing entry is a one-line
 * change. Only the registrable domain is listed — the public-suffix rule and
 * exact matching handle the rest.
 */
const CONSUMER_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  'aol.com',
  'aol.co.uk',
  'comcast.net',
  'duck.com',
  'fastmail.com',
  'fastmail.fm',
  'free.fr',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'guerrillamail.com',
  'hey.com',
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.fr',
  'hushmail.com',
  'icloud.com',
  'inbox.lv',
  'laposte.net',
  'libero.it',
  'live.co.uk',
  'live.com',
  'mail.com',
  'mail.ru',
  'mailinator.com',
  'me.com',
  'msn.com',
  'mac.com',
  'naver.com',
  'orange.fr',
  'outlook.com',
  'outlook.fr',
  'pm.me',
  'proton.me',
  'protonmail.ch',
  'protonmail.com',
  'qq.com',
  'rediffmail.com',
  'rocketmail.com',
  'seznam.cz',
  'sharklasers.com',
  'sky.com',
  't-online.de',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'tutanota.com',
  'tuta.io',
  'verizon.net',
  'web.de',
  'wp.pl',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.fr',
  'yandex.com',
  'yandex.ru',
  'ymail.com',
  'zoho.com',
])

/** Bracketed IPv6 (`[::1]`), bare IPv6, and dotted-quad IPv4. */
const isIpLiteral = (value: string): boolean => {
  const unwrapped = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value
  // IPv6 needs at least two colons and nothing outside hex/colon/dot, so a
  // host:port typo like `example.com:25` stays a malformed hostname rather
  // than being reported as an address.
  const colons = unwrapped.split(':').length - 1
  if (colons >= 2 && /^[0-9a-f:.]+$/i.test(unwrapped)) return true
  if (colons > 0) return false
  const quads = unwrapped.split('.')
  if (quads.length !== 4) return false
  return quads.every((quad) =>
    quad.length > 0
    && quad.length <= 3
    && /^[0-9]+$/.test(quad)
    && Number(quad) <= 255)
}

const isLocalName = (domain: string): boolean =>
  domain === 'localhost'
  || domain === 'local'
  || domain.endsWith('.localhost')
  || domain.endsWith('.local')

/**
 * Normalise to the stored form: lowercase, punycode/ASCII, no trailing dot.
 * Rejects anything that is not a plain hostname — an address, a URL fragment,
 * an IP literal or a loopback name.
 */
export const normaliseDomain = (input: string): DomainDecision => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'malformed' }
  // A single trailing dot is the DNS root and is dropped; two is malformed.
  const rootless = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
  if (rootless.length === 0) return { ok: false, reason: 'malformed' }
  // Before the punctuation check, or an IPv6 literal's colons report as
  // `malformed` and the admin is told to fix a typo they did not make.
  if (isIpLiteral(rootless)) return { ok: false, reason: 'ip_literal' }
  if (/[\s@/:\\?#]/.test(rootless)) return { ok: false, reason: 'malformed' }

  const ascii = toAsciiDomain(rootless.toLowerCase())
  if (ascii.length === 0) return { ok: false, reason: 'malformed' }
  // The parser maps some non-hostname input through without complaint (an
  // underscore, for one), so the shape is asserted here rather than assumed.
  if (!/^[a-z0-9.-]+$/.test(ascii)) return { ok: false, reason: 'malformed' }
  if (isIpLiteral(ascii)) return { ok: false, reason: 'ip_literal' }
  if (isLocalName(ascii)) return { ok: false, reason: 'localhost' }
  if (ascii.length > MAX_DOMAIN_LENGTH) return { ok: false, reason: 'too_long' }

  const labels = ascii.split('.')
  if (labels.length < 2) return { ok: false, reason: 'single_label' }
  for (const label of labels) {
    if (label.length === 0) return { ok: false, reason: 'malformed' }
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'too_long' }
    if (label.startsWith('-') || label.endsWith('-')) {
      return { ok: false, reason: 'malformed' }
    }
  }

  return { ok: true, domain: ascii }
}

/** The domain part of an address, normalised, or null when there isn't one. */
export const domainOfEmail = (email: string): string | null => {
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  const decision = normaliseDomain(email.slice(at + 1))
  return decision.ok ? decision.domain : null
}

/**
 * `isPublicSuffix` is injected so this module stays pure and the caller owns
 * the `tldts` dependency. `api`/`worker` pass the real one; unit tests pass a
 * table. A domain that IS a public suffix (`co.uk`, `github.io`) is refused —
 * nobody controls the mailboxes under one.
 */
export type PublicSuffixOracle = (domain: string) => boolean

export const classifyEmailDomain = (
  domain: string,
  isPublicSuffix: PublicSuffixOracle,
): DomainDecision => {
  const normalised = normaliseDomain(domain)
  if (!normalised.ok) return normalised
  if (isPublicSuffix(normalised.domain)) {
    return { ok: false, reason: 'public_suffix' }
  }
  if (CONSUMER_PROVIDER_DOMAINS.has(normalised.domain)) {
    return { ok: false, reason: 'consumer_provider' }
  }
  return normalised
}

/** Exported for the test that pins the list, and for admin copy. */
export const consumerProviderDomains = (): readonly string[] =>
  [...CONSUMER_PROVIDER_DOMAINS].sort()

/** Admin-facing reason text. Closed map, so a new rejection cannot go unnamed. */
export const DOMAIN_REJECTION_MESSAGES: Readonly<Record<DomainRejection, string>> = {
  consumer_provider: 'This is a personal email provider, so it cannot prove who works where.',
  ip_literal: 'Enter a domain name, not an IP address.',
  localhost: 'This is a local-only name and cannot be verified publicly.',
  malformed: 'This does not look like a domain name.',
  public_suffix: 'This is a public registry suffix, not a domain somebody can own.',
  single_label: 'Enter a full domain, such as example.com.',
  too_long: 'This domain is longer than DNS allows.',
}
