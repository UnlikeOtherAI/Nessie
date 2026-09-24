import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DeepWaterResearchEventSchema, deepWaterProgressFromEvent } from '@nessie/schemas'

import {
  authenticateDeepWaterEvent,
  readDeepWaterEventsSecret,
} from '../src/services/deepwater-research-events.js'

/**
 * DeepWater's research events, checked against DeepWater's own published
 * contract (Water plan amendments-streaming S1, S2).
 *
 * `fixtures/deepwater-research-event.v1.examples.json` is DeepWater's
 * `docs/contracts/research-event.v1.examples.json` — one example per event
 * type and an HMAC test vector, generated in the Water repo from
 * `api/src/lib/nessie-research-event.ts` — copied byte-for-byte:
 *
 *   git -C <water> show <commit>:docs/contracts/research-event.v1.examples.json \
 *     > api/test/fixtures/deepwater-research-event.v1.examples.json
 *
 * then set `WATER_CONTRACT_SOURCE` to that commit and the file's sha256.
 * Never edit it by hand: the pin fails until the copy is DeepWater's again.
 */

const WATER_CONTRACT_SOURCE = {
  repository: 'UnlikeOtherAI/water',
  path: 'docs/contracts/research-event.v1.examples.json',
  commit: 'd339d877e98464705d902880cafa4b94227b95db',
  sha256: '26640a40c0451cfe066498f54bc8f4684ffbfad5f5d0c80a2eac1eca5852cb2a',
} as const

const fixtureBytes = readFileSync(new URL('./fixtures/deepwater-research-event.v1.examples.json', import.meta.url))
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  ver: string
  examples: Record<string, Record<string, unknown>>
  hmac_test_vector: { raw_body: string; secret: string; signature: string }
}

const example = (name: string): Record<string, unknown> => {
  const found = fixture.examples[name]
  if (!found) throw new Error(`DeepWater's fixture has no ${name} example`)
  return structuredClone(found)
}

const parses = (body: unknown): boolean => DeepWaterResearchEventSchema.safeParse(body).success

test('the fixture is DeepWater\'s published contract, byte for byte', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), WATER_CONTRACT_SOURCE.sha256)
  assert.equal(fixture.ver, 'deepwater.research-event.v1')
})

test('every example DeepWater publishes is a valid event', () => {
  const names = Object.keys(fixture.examples).sort()
  assert.deepEqual(names, [
    'research.cancelled',
    'research.completed',
    'research.completed.summary',
    'research.failed',
    'research.progress',
    'research.scope.turn_settled',
  ])
  for (const name of names) {
    const parsed = DeepWaterResearchEventSchema.safeParse(example(name))
    assert.ok(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
  }
  const progress = DeepWaterResearchEventSchema.parse(example('research.progress')).progress
  assert.ok(progress)
  assert.deepEqual(deepWaterProgressFromEvent(progress), {
    at: '2026-09-23T10:15:00.000Z',
    note: 'Finding and reading sources',
    percent: 40,
    phase: 'gathering',
    sourcesFound: 23,
  })
})

test('the body is as strict as DeepWater\'s own schema', () => {
  const mutate = (name: string, change: (body: Record<string, any>) => void): Record<string, unknown> => {
    const body = example(name)
    change(body)
    return body
  }
  // Unknown members, at every level.
  assert.equal(parses(mutate('research.progress', (body) => { body.extra = 1 })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.research.report = 'text' })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.progress.eta = 5 })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.nessie.email = 'a@b.c' })), false)
  // `progress` exactly on progress; `turn` exactly on a settled turn.
  assert.equal(parses(mutate('research.progress', (body) => { body.progress = null })), false)
  assert.equal(parses(mutate('research.failed', (body) => {
    body.progress = example('research.progress').progress
  })), false)
  assert.equal(parses(mutate('research.scope.turn_settled', (body) => { body.turn = null })), false)
  // The status each type carries.
  assert.equal(parses(mutate('research.progress', (body) => { body.research.status = 'drafting' })), false)
  assert.equal(parses(mutate('research.completed', (body) => { body.research.status = 'running' })), false)
  assert.equal(parses(mutate('research.failed', (body) => { body.research.status = 'complete' })), false)
  assert.equal(parses(mutate('research.cancelled', (body) => { body.research.status = 'failed' })), false)
  // A turn can settle as the brief is launched or cancelled, never as it finishes.
  for (const status of ['drafting', 'running', 'cancelled']) {
    assert.equal(parses(mutate('research.scope.turn_settled', (body) => { body.research.status = status })), true, status)
  }
  assert.equal(parses(mutate('research.scope.turn_settled', (body) => { body.research.status = 'complete' })), false)
  // `report_kind` exactly on completion; `public_url` only there.
  assert.equal(parses(mutate('research.completed', (body) => { body.research.report_kind = null })), false)
  assert.equal(parses(mutate('research.failed', (body) => { body.research.report_kind = 'full' })), false)
  assert.equal(parses(mutate('research.progress', (body) => {
    body.research.public_url = 'https://research.deepwater.live/x'
  })), false)
  assert.equal(parses(mutate('research.completed', (body) => {
    body.research.public_url = 'http://research.deepwater.live/x'
  })), false)
  // Shapes: the event id, the progress numbers, the phase.
  assert.equal(parses(mutate('research.progress', (body) => { body.event_id = 'evt_123' })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.progress.percent = 101 })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.progress.sources_found = -1 })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.progress.phase = 'thinking' })), false)
  assert.equal(parses(mutate('research.progress', (body) => { body.ver = 'deepwater.research-event.v2' })), false)
})

const VECTOR = fixture.hmac_test_vector
const VECTOR_EVENT = JSON.parse(VECTOR.raw_body) as { event_id: string; sent_at: string }

const authenticate = (overrides: Partial<Parameters<typeof authenticateDeepWaterEvent>[0]> = {}) =>
  authenticateDeepWaterEvent({
    secret: VECTOR.secret,
    rawBody: Buffer.from(VECTOR.raw_body, 'utf8'),
    signature: VECTOR.signature,
    eventIdHeader: VECTOR_EVENT.event_id,
    body: JSON.parse(VECTOR.raw_body),
    now: new Date(VECTOR_EVENT.sent_at),
    ...overrides,
  })

test('DeepWater\'s HMAC test vector verifies over the exact raw body', () => {
  const verified = authenticate()
  assert.equal(verified.ok, true)
  assert.equal(verified.ok && verified.event.event_id, VECTOR_EVENT.event_id)
  // The vector is what signing the bytes gives, not a value copied by luck.
  assert.equal(
    `sha256=${createHmac('sha256', VECTOR.secret).update(VECTOR.raw_body).digest('hex')}`,
    VECTOR.signature,
  )
})

test('a signature that does not match the bytes, the key or the scheme is refused as 401', () => {
  const refused = (overrides: Partial<Parameters<typeof authenticateDeepWaterEvent>[0]>) => {
    const result = authenticate(overrides)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 401)
      assert.equal(result.code, 'DEEP_WATER_EVENT_SIGNATURE_INVALID')
    }
  }
  // One byte of the body re-serialised differently is another body.
  refused({ rawBody: Buffer.from(JSON.stringify(JSON.parse(VECTOR.raw_body), null, 1), 'utf8') })
  refused({ secret: `${VECTOR.secret}x` })
  refused({ signature: VECTOR.signature.replace(/^sha256=/, '') })
  refused({ signature: VECTOR.signature.replace(/^sha256=/, 'sha1=') })
  refused({ signature: `${VECTOR.signature.slice(0, -2)}00` })
  refused({ signature: null })
  refused({ rawBody: undefined })
})

test('a sent_at more than ten minutes from now, either way, is refused as stale', () => {
  const sentAt = Date.parse(VECTOR_EVENT.sent_at)
  const at = (offsetMs: number) => authenticate({ now: new Date(sentAt + offsetMs) })
  assert.equal(at(10 * 60_000).ok, true)
  assert.equal(at(-10 * 60_000).ok, true)
  for (const offset of [10 * 60_000 + 1, -(10 * 60_000 + 1), 24 * 3_600_000]) {
    const result = at(offset)
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.code, 'DEEP_WATER_EVENT_STALE')
    assert.equal(!result.ok && result.status, 401)
  }
})

test('a signed body outside the contract, or naming another event id, is refused as 400', () => {
  const malformed = { ...JSON.parse(VECTOR.raw_body), extra: true }
  const raw = JSON.stringify(malformed)
  const result = authenticate({
    body: malformed,
    rawBody: Buffer.from(raw, 'utf8'),
    signature: `sha256=${createHmac('sha256', VECTOR.secret).update(raw).digest('hex')}`,
  })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 400)
  assert.equal(!result.ok && result.code, 'DEEP_WATER_EVENT_MALFORMED')

  const otherId = authenticate({ eventIdHeader: 'evt_00000000000000000000000000000000' })
  assert.equal(!otherId.ok && otherId.code, 'DEEP_WATER_EVENT_MALFORMED')
  const noId = authenticate({ eventIdHeader: null })
  assert.equal(!noId.ok && noId.status, 400)
})

test('the receiver has a key only when one of DeepWater\'s length is set', () => {
  assert.equal(readDeepWaterEventsSecret({}), null)
  assert.equal(readDeepWaterEventsSecret({ DEEPWATER_EVENTS_SECRET: '   ' }), null)
  const errors: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    assert.equal(readDeepWaterEventsSecret({ DEEPWATER_EVENTS_SECRET: 'too-short' }), null)
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1, 'a key too short to be DeepWater\'s is said, never used')
  assert.equal(readDeepWaterEventsSecret({ DEEPWATER_EVENTS_SECRET: ` ${VECTOR.secret} ` }), VECTOR.secret)
})
