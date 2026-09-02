/**
 * Address normalization and local-part rules for hosted mailboxes.
 *
 * An address is claimed first-come within the deployment (a plain unique index
 * — the deployment's own SES account owns the domain, so there is no external
 * allocator to ask). Deleting a mailbox retires the address permanently rather
 * than releasing it: a recycled local part would silently inherit an old
 * correspondent's trust and their in-flight threads.
 */

/**
 * Local parts that belong to the operator or to the mail infrastructure itself.
 * RFC 2142 role addresses plus the obvious impersonation risks; `postmaster`
 * and `abuse` are required by RFC to reach a human, not an agent.
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'abuse',
  'admin',
  'administrator',
  'billing',
  'dmarc',
  'help',
  'hostmaster',
  'info',
  'mail',
  'mailer-daemon',
  'no-reply',
  'noc',
  'noreply',
  'postmaster',
  'root',
  'security',
  'ssl-admin',
  'support',
  'sysadmin',
  'usenet',
  'uucp',
  'webmaster',
])

/**
 * Deliberately stricter than RFC 5321: lowercase alphanumerics plus a single
 * internal dot/hyphen run. A quoted local part is legal and unusable — it would
 * have to survive our own URLs, DKIM alignment and every correspondent's client.
 */
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9]|[.-](?![.-]))*[a-z0-9]$/

export const MIN_LOCAL_PART_LENGTH = 3
export const MAX_LOCAL_PART_LENGTH = 64

export type LocalPartRejection =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'reserved'

export const validateLocalPart = (
  raw: string,
): { ok: true; localPart: string } | { ok: false; reason: LocalPartRejection } => {
  const localPart = raw.trim().toLowerCase()
  if (localPart.length < MIN_LOCAL_PART_LENGTH) return { ok: false, reason: 'too_short' }
  if (localPart.length > MAX_LOCAL_PART_LENGTH) return { ok: false, reason: 'too_long' }
  if (!LOCAL_PART_PATTERN.test(localPart)) return { ok: false, reason: 'invalid_characters' }
  if (RESERVED_LOCAL_PARTS.has(localPart)) return { ok: false, reason: 'reserved' }
  return { localPart, ok: true }
}

export const localPartRejectionMessage = (reason: LocalPartRejection): string => {
  switch (reason) {
    case 'too_short':
      return `An address needs at least ${MIN_LOCAL_PART_LENGTH} characters.`
    case 'too_long':
      return `An address can be at most ${MAX_LOCAL_PART_LENGTH} characters.`
    case 'invalid_characters':
      return 'Use lowercase letters, numbers, and single dots or hyphens between them.'
    case 'reserved':
      return 'That name is reserved for the operator of this deployment.'
  }
}

/** Suggestions offered when a first-come claim loses the race. */
export const suggestLocalParts = (
  localPart: string,
  taken: ReadonlySet<string>,
): string[] => {
  const candidates = [
    `${localPart}-team`,
    `${localPart}-desk`,
    `${localPart}1`,
    `the-${localPart}`,
  ]
  return candidates
    .filter((candidate) => {
      const validated = validateLocalPart(candidate)
      return validated.ok && !taken.has(validated.localPart)
    })
    .slice(0, 3)
}

export const buildAddress = (localPart: string, domain: string): string =>
  `${localPart.toLowerCase()}@${domain.toLowerCase()}`

/**
 * Extract the bare address from a header value or an SES envelope entry.
 * Returns null rather than guessing when there is no `@`: a routing decision
 * must never be made on a value we could not parse.
 */
export const normalizeAddress = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const trimmed = raw.trim()
  const angled = /<([^>]+)>/.exec(trimmed)
  const candidate = (angled?.[1] ?? trimmed).trim().toLowerCase()
  if (!candidate.includes('@') || /\s/.test(candidate)) return null
  return candidate
}

export const addressDomain = (address: string): string | null => {
  const at = address.lastIndexOf('@')
  return at === -1 ? null : address.slice(at + 1)
}

/**
 * RFC 5322 Message-ID normalization for the threading lookup: strip the angle
 * brackets and lowercase. Never a uniqueness authority — a forged or duplicated
 * value must degrade to a new conversation, never drop or mis-merge a message.
 */
export const normalizeMessageId = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '').trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

export const parseReferences = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  const matches = raw.match(/<[^>]+>/g) ?? raw.split(/\s+/)
  const ids = matches
    .map((entry) => normalizeMessageId(entry))
    .filter((entry): entry is string => Boolean(entry))
  return [...new Set(ids)]
}
