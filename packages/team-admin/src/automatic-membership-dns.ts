/**
 * DNS proof that an organisation controls an email domain.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §7.
 *
 * In this package rather than in `api/src/services` because the api verifies on
 * demand and the worker revalidates on a schedule, and both must reach the same
 * verdict from the same code.
 *
 * The resolver is an injected seam, the same shape
 * `packages/agent-mail/src/mailbox-discovery.ts` uses, so the state machine is
 * testable without a network or a live zone.
 */

import { randomBytes } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'

import { domainVerificationRecordName, domainVerificationRecordValue } from '@nessie/schemas'

/** Injected so tests drive the state machine without DNS. */
export type DomainVerificationDns = {
  txt: (name: string) => Promise<string[][]>
}

export const defaultDomainVerificationDns: DomainVerificationDns = {
  txt: (name: string) => resolveTxt(name),
}

const LOOKUP_TIMEOUT_MS = 5_000

/** 32 bytes, unpadded base32 — URL-safe, case-insensitive, no DNS quoting. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const generateDomainChallenge = (): string => {
  const bytes = randomBytes(32)
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export type DomainCheckOutcome = 'match' | 'no_match' | 'no_record' | 'lookup_failed'

export type DomainCheckResult = {
  outcome: DomainCheckOutcome
  /** Non-sensitive summary for the admin surface and the audit trail. */
  detail: string
}

const withTimeout = async <T>(operation: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Look for the challenge in TXT records at the verification name.
 *
 * The name is built from the caller's **stored** domain — never from raw admin
 * input — because UTS-46 folds full-width and confusable forms into ASCII, and
 * checking one string while using another is a check-vs-use mismatch.
 *
 * A record may arrive as several strings (RFC 1035 caps one at 255 octets), so
 * each record's chunks are joined before comparison. Any matching record at the
 * name passes: a zone legitimately carries other TXT records.
 *
 * The comparison is a plain string compare. The challenge is published in DNS,
 * so it is not a secret, and a constant-time compare over a public value would
 * be cargo cult — and `timingSafeEqual` throws on unequal lengths besides.
 */
export const checkDomainChallenge = async (
  storedDomain: string,
  challenge: string,
  dns: DomainVerificationDns = defaultDomainVerificationDns,
): Promise<DomainCheckResult> => {
  const name = domainVerificationRecordName(storedDomain)
  const expected = domainVerificationRecordValue(challenge)

  let records: string[][]
  try {
    records = await withTimeout(dns.txt(name), LOOKUP_TIMEOUT_MS)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { detail: `No TXT record at ${name}.`, outcome: 'no_record' }
    }
    const message = error instanceof Error ? error.message : 'unknown resolver error'
    return { detail: `Lookup failed: ${message}`, outcome: 'lookup_failed' }
  }

  if (records.length === 0) {
    return { detail: `No TXT record at ${name}.`, outcome: 'no_record' }
  }
  const joined = records.map((chunks) => chunks.join('').trim())
  if (joined.some((record) => record === expected)) {
    return {
      detail: `Matched at ${name} (${joined.length} TXT record${joined.length === 1 ? '' : 's'} present).`,
      outcome: 'match',
    }
  }
  return {
    detail: `Found ${joined.length} TXT record${joined.length === 1 ? '' : 's'} at ${name}, none carrying the current challenge.`,
    outcome: 'no_match',
  }
}

/**
 * A claim needs two successful observations at least this far apart before it
 * takes the instance-wide exclusivity lock, so one spoofed or cache-poisoned
 * answer cannot mint a claim and lock the real owner out.
 */
export const SECOND_OBSERVATION_MIN_GAP_MS = 10 * 60 * 1000

/** How long an unproven challenge stays valid before it must be rotated. */
export const CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How stale a proven domain may get before revalidation is due. */
export const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Consecutive revalidation failures that suspend provisioning. */
export const REVALIDATION_FAILURE_LIMIT = 3

export type DomainVerificationVerdict =
  | { kind: 'verified' }
  | { kind: 'first_observation' }
  | { kind: 'awaiting_second_observation'; readyAt: Date }
  | { kind: 'failed'; detail: string }
  | { kind: 'expired' }

/**
 * The pure decision half of verification: given the stored row's timestamps and
 * one fresh check, say what the claim becomes. Kept separate from persistence
 * so every branch is unit-testable without a database.
 */
export const evaluateVerification = (input: {
  now: Date
  challengeExpiresAt: Date
  firstSeenAt: Date | null
  check: DomainCheckResult
}): DomainVerificationVerdict => {
  if (input.check.outcome !== 'match') {
    if (input.now >= input.challengeExpiresAt) return { kind: 'expired' }
    return { detail: input.check.detail, kind: 'failed' }
  }
  if (input.now >= input.challengeExpiresAt) return { kind: 'expired' }
  if (!input.firstSeenAt) return { kind: 'first_observation' }
  const readyAt = new Date(input.firstSeenAt.getTime() + SECOND_OBSERVATION_MIN_GAP_MS)
  if (input.now < readyAt) return { kind: 'awaiting_second_observation', readyAt }
  return { kind: 'verified' }
}
