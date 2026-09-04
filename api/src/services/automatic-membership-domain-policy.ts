import { domainToASCII } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'tldts'

/** Pinned policy data, reviewed with every dependency/security update. */
export const DOMAIN_CLASSIFIER_VERSION = 'tldts-7.0.19+free-email-domains-1.11.4+disposable-email-domains-1.0.62'

// The PSL comes from tldts' bundled, versioned Mozilla PSL snapshot. Consumer
// and disposable data are pinned, auditable maintained datasets; no MX or
// spelling heuristic decides an access-control domain.
const require = createRequire(import.meta.url)
const disposableDomains = new Set<string>(require('disposable-email-domains') as string[])
const consumerDomains = new Set<string>(require('free-email-domains') as string[])

export class DomainPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Canonical exact-domain form. This never accepts an email address. */
export const normalizeAutomaticMembershipDomain = (input: string): string => {
  const raw = input.trim().replace(/\.$/, '')
  if (!raw || raw.length > 253 || raw.includes('@') || raw.includes('/') || raw.includes('..')) {
    throw new DomainPolicyError('INVALID_DOMAIN', 'Enter a valid exact email domain.')
  }
  // IPv4/IPv6 literals and localhost/private pseudo-TLDs are not DNS domains.
  if (raw.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw) || /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(raw.toLowerCase())) {
    throw new DomainPolicyError('UNSAFE_DOMAIN', 'This domain cannot be used for automatic access.')
  }
  const ascii = domainToASCII(raw).toLowerCase()
  if (!ascii || ascii.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ascii)) {
    throw new DomainPolicyError('INVALID_DOMAIN', 'Enter a valid exact email domain.')
  }
  return ascii
}

export const assertAutomaticMembershipDomainAllowed = (input: string): string => {
  const domain = normalizeAutomaticMembershipDomain(input)
  const parsed = parse(domain, { allowPrivateDomains: false })
  // A suffix is public when it is syntactically a recognised suffix but has
  // no registrable domain. This correctly handles PSL wildcards/exceptions.
  if (!parsed.publicSuffix || !parsed.domain) {
    throw new DomainPolicyError('PUBLIC_SUFFIX', 'A public suffix cannot be used for automatic access.')
  }
  if (consumerDomains.has(domain) || disposableDomains.has(domain)) {
    throw new DomainPolicyError('CONSUMER_DOMAIN', 'Consumer and disposable email domains cannot be used.')
  }
  return domain
}

export const automaticMembershipTxtName = (domain: string): string =>
  `_nessie-auto-access.${domain}`
