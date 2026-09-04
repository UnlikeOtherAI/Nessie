import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

export class MailboxDiscoveryAddressError extends Error {
  constructor(message = 'Enter a valid email address.') {
    super(message)
    this.name = 'MailboxDiscoveryAddressError'
  }
}

/** Reject literals, local names, and malformed DNS hostnames before egress. */
export const mailboxDiscoveryHostname = (raw: string): string | null => {
  const value = raw.trim().toLowerCase().replace(/\.+$/, '')
  if (
    value.length === 0 || value.length > 253 || isIP(value) !== 0
    || value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')
  ) return null
  const labels = value.split('.')
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null
  }
  return value
}

export type ParsedMailboxDiscoveryAddress = { domain: string; email: string }

export const parseMailboxDiscoveryAddress = (raw: string): ParsedMailboxDiscoveryAddress => {
  const input = raw.trim()
  const at = input.lastIndexOf('@')
  if (
    at <= 0 || at !== input.indexOf('@') || at === input.length - 1 || input.length > 320
    || /[\s\u0000-\u001f\u007f]/.test(input)
  ) throw new MailboxDiscoveryAddressError()
  const localPart = input.slice(0, at)
  const asciiDomain = domainToASCII(input.slice(at + 1).replace(/\.+$/, ''))
  const domain = mailboxDiscoveryHostname(asciiDomain)
  if (!domain || localPart.length > 64) throw new MailboxDiscoveryAddressError()
  return { domain, email: `${localPart}@${domain}` }
}
