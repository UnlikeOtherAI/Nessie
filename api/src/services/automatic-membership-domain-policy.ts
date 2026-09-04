import { domainToASCII } from 'node:url'

/** Pinned policy data, reviewed with every dependency/security update. */
export const DOMAIN_CLASSIFIER_VERSION = '2026-09-04.1'

// This is intentionally an explicit denylist rather than a heuristic. It is
// audited in source and covers the providers that make consumer mail public.
const CONSUMER_OR_DISPOSABLE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com',
  'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com',
  'mail.com', 'aol.com', 'gmx.com', 'gmx.net', 'zoho.com', 'fastmail.com',
  'hey.com', 'duck.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com',
  'mailinator.com', 'yopmail.com', 'dispostable.com', 'trashmail.com',
])

const configuredPublicSuffixes = (): Set<string> => {
  // This must be the complete, versioned PSL artifact supplied by deployment
  // automation. A truncated fallback is an unsafe authorization classifier.
  const supplied = process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL
  const version = process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL_VERSION
  if (!supplied || !version) {
    throw new DomainPolicyError('DOMAIN_POLICY_UNAVAILABLE', 'A maintained public-suffix classifier is required before domains can be configured.')
  }
  return new Set(supplied.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
}

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
  const suffixes = configuredPublicSuffixes()
  if (suffixes.has(domain)) {
    throw new DomainPolicyError('PUBLIC_SUFFIX', 'A public suffix cannot be used for automatic access.')
  }
  if (CONSUMER_OR_DISPOSABLE_DOMAINS.has(domain)) {
    throw new DomainPolicyError('CONSUMER_DOMAIN', 'Consumer and disposable email domains cannot be used.')
  }
  return domain
}

export const automaticMembershipTxtName = (domain: string): string =>
  `_nessie-auto-access.${domain}`
