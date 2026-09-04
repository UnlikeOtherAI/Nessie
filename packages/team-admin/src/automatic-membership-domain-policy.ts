import { createRequire } from 'node:module'
import { domainToASCII } from 'node:url'
import { parse } from 'tldts'

export const DOMAIN_CLASSIFIER_VERSION = 'tldts-7.0.19+free-email-domains-1.11.4+disposable-email-domains-1.0.62'
const require = createRequire(import.meta.url)
const consumers = new Set<string>(require('free-email-domains') as string[])
const disposable = new Set<string>(require('disposable-email-domains') as string[])

export class DomainPolicyError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export const normalizeAutomaticMembershipDomain = (input: string): string => {
  const raw = input.trim().replace(/\.$/, '')
  if (!raw || raw.length > 253 || raw.includes('@') || raw.includes('/') || raw.includes('..')) throw new DomainPolicyError('INVALID_DOMAIN', 'Enter a valid exact email domain.')
  if (raw.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw) || /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(raw.toLowerCase())) throw new DomainPolicyError('UNSAFE_DOMAIN', 'This domain cannot be used for automatic access.')
  const domain = domainToASCII(raw).toLowerCase()
  if (!domain || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new DomainPolicyError('INVALID_DOMAIN', 'Enter a valid exact email domain.')
  return domain
}

export const assertAutomaticMembershipDomainAllowed = (input: string): string => {
  const domain = normalizeAutomaticMembershipDomain(input)
  const parsed = parse(domain, { allowPrivateDomains: false })
  if (!parsed.publicSuffix || !parsed.domain) throw new DomainPolicyError('PUBLIC_SUFFIX', 'A public suffix cannot be used for automatic access.')
  if (consumers.has(domain) || disposable.has(domain)) throw new DomainPolicyError('CONSUMER_DOMAIN', 'Consumer and disposable email domains cannot be used.')
  return domain
}

export const automaticMembershipTxtName = (domain: string): string => `_nessie-auto-access.${domain}`
