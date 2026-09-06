/**
 * The public-suffix oracle for automatic team access
 * (`docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md` §6).
 *
 * `@nessie/schemas`' `classifyEmailDomain` takes the oracle as a parameter so
 * that package stays pure (zod only) and its tests stay table-driven. This is
 * the one production implementation, shared by the api routes and the worker
 * jobs so a domain cannot be accepted at claim time and refused at grant time.
 *
 * `tldts` ships a continuously refreshed Public Suffix List and, by default,
 * considers only the ICANN section — the private section lists things like
 * `github.io`, which we also want refused, so `allowPrivateDomains` is on.
 */

import { getDomain, getPublicSuffix } from 'tldts'

import type { PublicSuffixOracle } from '@nessie/schemas'

const PARSE_OPTIONS = {
  allowIcannDomains: true,
  allowPrivateDomains: true,
} as const

/**
 * True when the name is a suffix nobody can own a mailbox under — either it IS
 * a public suffix (`co.uk`, `github.io`), or it has no registrable domain at
 * all. Both are refusals for the same reason, so both answer true here.
 */
export const isPublicSuffix: PublicSuffixOracle = (domain: string): boolean => {
  const registrable = getDomain(domain, PARSE_OPTIONS)
  if (registrable === null) return true
  return getPublicSuffix(domain, PARSE_OPTIONS) === domain
}
