import assert from 'node:assert/strict'
import test from 'node:test'

import { WriteScopedSettingBodySchema } from '../src/contracts/scoped-settings.js'

/**
 * One panel serves all three scopes, so it holds "the team, if any" in a
 * single variable and sends it as `null` at organisation and personal scope.
 * A `.strict()` `.optional()` field refused that with "Expected string,
 * received null", which is how every press of the organisation's "don't allow
 * another key below this" checkbox failed — the only control on the panel
 * that writes a setting with no value of its own.
 */
test('a scoped-setting write accepts a null teamId outside team scope', () => {
  for (const scope of ['organization', 'user'] as const) {
    const parsed = WriteScopedSettingBodySchema.safeParse({
      locked: true,
      scope,
      teamId: null,
      value: null,
    })
    assert.equal(parsed.success, true, `${scope} scope rejected a null teamId`)
  }
})

test('a scoped-setting write still accepts an absent teamId', () => {
  const parsed = WriteScopedSettingBodySchema.safeParse({
    locked: false,
    scope: 'organization',
    value: 'anything',
  })
  assert.equal(parsed.success, true)
})

test('a scoped-setting write still refuses a teamId that is not a uuid', () => {
  const parsed = WriteScopedSettingBodySchema.safeParse({
    locked: false,
    scope: 'team',
    teamId: 'not-a-uuid',
    value: null,
  })
  assert.equal(parsed.success, false)
})

test('a scoped-setting write still refuses unknown fields', () => {
  const parsed = WriteScopedSettingBodySchema.safeParse({
    locked: false,
    scope: 'organization',
    surprise: true,
  })
  assert.equal(parsed.success, false)
})
