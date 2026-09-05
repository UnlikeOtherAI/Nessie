import assert from 'node:assert/strict'
import test from 'node:test'

import { createStreamRedactor } from './stream-redaction.js'

const drain = (chunks: string[]): string => {
  const redactor = createStreamRedactor()
  const emitted = chunks.map((chunk) => redactor.push(chunk)).join('')
  return emitted + redactor.flush()
}

test('a credential split across chunks is never broadcast in the clear', () => {
  // The failure this exists for: a provider splits wherever it likes, so
  // neither `sk_live_` nor the rest of the key matches on its own.
  const key = `sk_live_${'1234567890abcdefghij'}`
  const emitted = drain(['here is the key ', 'sk_live_', '1234567890abcdefghij', ' — use it'])

  assert.doesNotMatch(emitted, /1234567890abcdefghij/)
  assert.match(emitted, /sk_live_•{12}/)
  assert.ok(!emitted.includes(key))
})

test('a credential arriving as single characters is still caught', () => {
  const emitted = drain([...`token: ${'A1b2C3d4E5f6G7h8I9j0'} done`])

  assert.doesNotMatch(emitted, /A1b2C3d4E5f6G7h8I9j0/)
})

test('ordinary prose streams through unchanged once flushed', () => {
  const prose = 'The deploy finished and every check is green, so the release is ready to go out.'

  assert.equal(drain(prose.split(' ').map((word) => `${word} `)).trimEnd(), prose)
})

test('nothing is released while the tail could still be growing', () => {
  const redactor = createStreamRedactor()

  assert.equal(redactor.push('short text'), '')
  assert.equal(redactor.flush(), 'short text')
})
