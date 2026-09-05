import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHALLENGE_TTL_MS,
  SECOND_OBSERVATION_MIN_GAP_MS,
  checkDomainChallenge,
  evaluateVerification,
  generateDomainChallenge,
  type DomainVerificationDns,
} from '../src/automatic-membership-dns.js'
import {
  domainVerificationRecordName,
  domainVerificationRecordValue,
} from '@nessie/schemas'

const CHALLENGE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST'

const dnsReturning = (records: string[][]): DomainVerificationDns => ({
  txt: async () => records,
})

const dnsThrowing = (code?: string): DomainVerificationDns => ({
  txt: async () => {
    const error = new Error('lookup failed') as Error & { code?: string }
    if (code) error.code = code
    throw error
  },
})

test('a challenge is long, high-entropy and DNS-safe', () => {
  const first = generateDomainChallenge()
  const second = generateDomainChallenge()
  assert.notEqual(first, second)
  // 32 bytes of base32 is 52 characters; anything shorter is not 256 bits.
  assert.ok(first.length >= 52, `expected >= 52 chars, got ${first.length}`)
  assert.match(first, /^[A-Z2-7]+$/, 'base32 only, so no DNS quoting is ever needed')
})

test('the record name and value are built from the stored domain', () => {
  assert.equal(
    domainVerificationRecordName('example.com'),
    '_nessie-domain-verification.example.com',
  )
  assert.equal(
    domainVerificationRecordValue(CHALLENGE),
    `nessie-domain-verification=${CHALLENGE}`,
  )
})

test('the lookup uses the stored domain verbatim, never a re-derived one', async () => {
  const seen: string[] = []
  const dns: DomainVerificationDns = {
    txt: async (name) => {
      seen.push(name)
      return []
    },
  }
  await checkDomainChallenge('xn--bcher-kva.de', CHALLENGE, dns)
  assert.deepEqual(seen, ['_nessie-domain-verification.xn--bcher-kva.de'])
})

test('a matching record passes', async () => {
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([[`nessie-domain-verification=${CHALLENGE}`]]),
  )
  assert.equal(result.outcome, 'match')
})

test('a record split across RFC 1035 chunks is joined before comparing', async () => {
  const value = `nessie-domain-verification=${CHALLENGE}`
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([[value.slice(0, 30), value.slice(30)]]),
  )
  assert.equal(result.outcome, 'match')
})

test('any matching record at the name passes, beside unrelated TXT records', async () => {
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([
      ['v=spf1 include:example.net ~all'],
      ['some-other-verification=abc123'],
      [`nessie-domain-verification=${CHALLENGE}`],
    ]),
  )
  assert.equal(result.outcome, 'match')
})

test('a different challenge does not pass', async () => {
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([['nessie-domain-verification=SOMETHINGELSE']]),
  )
  assert.equal(result.outcome, 'no_match')
  assert.match(result.detail, /none carrying the current challenge/)
})

test('a prefix of the expected value does not pass', async () => {
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([[`nessie-domain-verification=${CHALLENGE.slice(0, 20)}`]]),
  )
  assert.equal(result.outcome, 'no_match')
})

test('a value carrying the challenge as a substring does not pass', async () => {
  const result = await checkDomainChallenge(
    'example.com',
    CHALLENGE,
    dnsReturning([[`x nessie-domain-verification=${CHALLENGE} y`]]),
  )
  assert.equal(result.outcome, 'no_match')
})

test('no records and a missing name are distinguished from a resolver fault', async () => {
  assert.equal((await checkDomainChallenge('e.com', CHALLENGE, dnsReturning([]))).outcome, 'no_record')
  assert.equal(
    (await checkDomainChallenge('e.com', CHALLENGE, dnsThrowing('ENOTFOUND'))).outcome,
    'no_record',
  )
  assert.equal(
    (await checkDomainChallenge('e.com', CHALLENGE, dnsThrowing('ENODATA'))).outcome,
    'no_record',
  )
  assert.equal(
    (await checkDomainChallenge('e.com', CHALLENGE, dnsThrowing('ESERVFAIL'))).outcome,
    'lookup_failed',
  )
})

const now = new Date('2026-09-04T12:00:00.000Z')
const notExpired = new Date(now.getTime() + CHALLENGE_TTL_MS)
const match = { detail: 'ok', outcome: 'match' } as const
const noMatch = { detail: 'nope', outcome: 'no_match' } as const

test('one successful observation is not enough to verify', () => {
  const verdict = evaluateVerification({
    challengeExpiresAt: notExpired,
    check: match,
    firstSeenAt: null,
    now,
  })
  assert.equal(verdict.kind, 'first_observation')
})

test('the second observation must be at least ten minutes after the first', () => {
  const tooSoon = evaluateVerification({
    challengeExpiresAt: notExpired,
    check: match,
    firstSeenAt: new Date(now.getTime() - SECOND_OBSERVATION_MIN_GAP_MS + 1000),
    now,
  })
  assert.equal(tooSoon.kind, 'awaiting_second_observation')

  const ready = evaluateVerification({
    challengeExpiresAt: notExpired,
    check: match,
    firstSeenAt: new Date(now.getTime() - SECOND_OBSERVATION_MIN_GAP_MS),
    now,
  })
  assert.equal(ready.kind, 'verified')
})

test('an expired challenge cannot verify, even with a matching record', () => {
  const verdict = evaluateVerification({
    challengeExpiresAt: new Date(now.getTime() - 1),
    check: match,
    firstSeenAt: new Date(now.getTime() - SECOND_OBSERVATION_MIN_GAP_MS),
    now,
  })
  assert.equal(verdict.kind, 'expired')
})

test('a failed check reports the resolver detail and never verifies', () => {
  const verdict = evaluateVerification({
    challengeExpiresAt: notExpired,
    check: noMatch,
    firstSeenAt: new Date(now.getTime() - SECOND_OBSERVATION_MIN_GAP_MS),
    now,
  })
  assert.equal(verdict.kind, 'failed')
  assert.equal(verdict.kind === 'failed' && verdict.detail, 'nope')
})
