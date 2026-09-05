/**
 * Sign-in matching and the queue payload it produces.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 *  - **No email reaches the queue.** `queue_jobs` rows are never deleted
 *    anywhere in this repo, so an address in a payload would be a permanent
 *    local copy of UOA identity data — forbidden by `docs/brief.md` →
 *    "Current SSO identity invariant".
 *  - **The idempotency key cannot burn permanently.** The queue's unique index
 *    on `idempotency_key` is full and its insert is `ON CONFLICT DO NOTHING`,
 *    so a key derived from anything durable would mean one dead job disables
 *    the feature for that person forever.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { enqueueAutomaticMembershipProvisioning } from '../src/services/automatic-membership/signin.js'

const ORG = '00000000-0000-4000-8000-0000000000c1'
const RULE_A = '00000000-0000-4000-8000-0000000000d1'
const RULE_B = '00000000-0000-4000-8000-0000000000d2'

type Enqueued = { sql: string; values: unknown[] }

const makeTransaction = (options: {
  rules?: { id: string }[]
  settingValue?: boolean | null
  enqueued: Enqueued[]
}) => ({
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    options.enqueued.push({ sql: strings.join('?'), values })
    return 1
  },
  automaticMembershipRule: {
    findMany: async () => options.rules ?? [],
  },
  scopedSetting: {
    findMany: async () =>
      options.settingValue === undefined || options.settingValue === null
        ? []
        : [{
          key: 'automaticMembership.enabled',
          lockedAtScope: null,
          scope: 'organization',
          value: options.settingValue,
        }],
  },
})

const payloadOf = (enqueued: Enqueued[]): Record<string, unknown> => {
  assert.equal(enqueued.length, 1, 'exactly one job')
  // `enqueueQueueJob` binds the payload as a JSON parameter.
  const jsonValue = enqueued[0]?.values.find(
    (value) => typeof value === 'string' && value.trim().startsWith('{'),
  )
  assert.ok(typeof jsonValue === 'string', 'a JSON payload parameter is bound')
  return JSON.parse(jsonValue) as Record<string, unknown>
}

const keyOf = (enqueued: Enqueued[]): string => {
  const key = enqueued[0]?.values.find(
    (value) => typeof value === 'string' && value.startsWith('auto-membership:provision:'),
  )
  assert.ok(typeof key === 'string', 'an idempotency key is bound')
  return key
}

test('a matching address enqueues the rules it matched', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }, { id: RULE_B }] }) as never,
    { email: 'person@example.com', organizationId: ORG, uoaSub: 'sub-1' },
  )
  assert.deepEqual(ruleIds, [RULE_A, RULE_B])
  assert.deepEqual(payloadOf(enqueued), {
    organizationId: ORG,
    ruleIds: [RULE_A, RULE_B],
    uoaSub: 'sub-1',
  })
})

test('the queue payload never carries the email address', async () => {
  const enqueued: Enqueued[] = []
  await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }] }) as never,
    { email: 'person@example.com', organizationId: ORG, uoaSub: 'sub-1' },
  )
  const payload = payloadOf(enqueued)
  assert.equal('email' in payload, false)
  const serialised = JSON.stringify(enqueued)
  assert.equal(serialised.includes('person@example.com'), false)
  assert.equal(serialised.includes('@example.com'), false)
})

test('the idempotency key is time-bucketed, so a dead job never burns it forever', async () => {
  const first: Enqueued[] = []
  await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued: first, rules: [{ id: RULE_A }] }) as never,
    {
      email: 'person@example.com',
      now: new Date('2026-09-04T12:00:30Z'),
      organizationId: ORG,
      uoaSub: 'sub-1',
    },
  )
  const second: Enqueued[] = []
  await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued: second, rules: [{ id: RULE_A }] }) as never,
    {
      email: 'person@example.com',
      now: new Date('2026-09-04T12:00:45Z'),
      organizationId: ORG,
      uoaSub: 'sub-1',
    },
  )
  const later: Enqueued[] = []
  await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued: later, rules: [{ id: RULE_A }] }) as never,
    {
      email: 'person@example.com',
      now: new Date('2026-09-04T12:05:00Z'),
      organizationId: ORG,
      uoaSub: 'sub-1',
    },
  )

  assert.equal(keyOf(first), keyOf(second), 'a burst of sign-ins collapses to one job')
  assert.notEqual(keyOf(first), keyOf(later), 'a later sign-in always gets a fresh key')
})

test('a non-matching address enqueues nothing', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [] }) as never,
    { email: 'person@other.example', organizationId: ORG, uoaSub: 'sub-1' },
  )
  assert.deepEqual(ruleIds, [])
  assert.equal(enqueued.length, 0)
})

test('a consumer provider never matches, whatever rules exist', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }] }) as never,
    { email: 'person@gmail.com', organizationId: ORG, uoaSub: 'sub-1' },
  )
  assert.deepEqual(ruleIds, [])
  assert.equal(enqueued.length, 0)
})

test('the organisation emergency stop prevents any enqueue', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }], settingValue: false }) as never,
    { email: 'person@example.com', organizationId: ORG, uoaSub: 'sub-1' },
  )
  assert.deepEqual(ruleIds, [])
  assert.equal(enqueued.length, 0)
})

test('an absent emergency-stop setting means enabled, not disabled', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }], settingValue: null }) as never,
    { email: 'person@example.com', organizationId: ORG, uoaSub: 'sub-1' },
  )
  assert.deepEqual(ruleIds, [RULE_A])
})

test('an explicitly unverified email is refused', async () => {
  const enqueued: Enqueued[] = []
  const ruleIds = await enqueueAutomaticMembershipProvisioning(
    makeTransaction({ enqueued, rules: [{ id: RULE_A }] }) as never,
    {
      email: 'person@example.com',
      emailVerified: false,
      organizationId: ORG,
      uoaSub: 'sub-1',
    },
  )
  assert.deepEqual(ruleIds, [])
  assert.equal(enqueued.length, 0)
})

test('sign-in is never broken by a failure in this path', async () => {
  const exploding = {
    $executeRaw: async () => { throw new Error('queue is down') },
    automaticMembershipRule: { findMany: async () => [{ id: RULE_A }] },
    scopedSetting: { findMany: async () => [] },
  }
  const ruleIds = await enqueueAutomaticMembershipProvisioning(exploding as never, {
    email: 'person@example.com',
    organizationId: ORG,
    uoaSub: 'sub-1',
  })
  assert.deepEqual(ruleIds, [], 'the error is swallowed, not thrown into the login transaction')
})
