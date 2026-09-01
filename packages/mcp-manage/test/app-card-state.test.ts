import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppConnectionStatus } from '@nessie/schemas'

import { deriveAppCardState, type AppAvailability } from '../src/index.js'

/**
 * The one status a card shows. Two questions decide it, in this order: does
 * this caller hold a connection at all, and if so which of its accounts is the
 * one worth reporting. Availability answers only the first.
 */

const availability = (overrides: Partial<AppAvailability> = {}): AppAvailability => ({
  blocked: false,
  deprecated: false,
  locked: false,
  serverUnreachable: false,
  ...overrides,
})

const none: readonly AppConnectionStatus[] = []

test('with no connection an app is available, or unavailable when its server is unreachable', () => {
  assert.equal(deriveAppCardState(availability(), none), 'available')
  assert.equal(deriveAppCardState(availability({ serverUnreachable: true }), none), 'unavailable')
})

test('blocked, deprecated and locked each read as disabled, and outrank an unreachable server', () => {
  for (const key of ['blocked', 'deprecated', 'locked'] as const) {
    assert.equal(deriveAppCardState(availability({ [key]: true }), none), 'disabled', key)
    assert.equal(
      deriveAppCardState(availability({ [key]: true, serverUnreachable: true }), none),
      'disabled',
      `${key} + unreachable`,
    )
  }
})

test('precedence among connections is error > auth_expired > connecting > multiple_accounts > connected', () => {
  const all: AppConnectionStatus[] = ['connected', 'connected', 'connecting', 'expired', 'error']
  const without = (...drop: AppConnectionStatus[]): AppConnectionStatus[] =>
    all.filter((status) => !drop.includes(status))

  assert.equal(deriveAppCardState(availability(), all), 'error')
  assert.equal(deriveAppCardState(availability(), without('error')), 'auth_expired')
  assert.equal(deriveAppCardState(availability(), without('error', 'expired')), 'connecting')
  assert.equal(
    deriveAppCardState(availability(), without('error', 'expired', 'connecting')),
    'multiple_accounts',
  )
  assert.equal(deriveAppCardState(availability(), ['connected']), 'connected')
})

test('only live accounts count toward multiple_accounts — a switched-off one does not', () => {
  assert.equal(deriveAppCardState(availability(), ['connected', 'disabled']), 'connected')
  assert.equal(deriveAppCardState(availability(), ['connected', 'connected']), 'multiple_accounts')
})

test('accounts that are all switched off are paused, never disabled — the person can undo it', () => {
  assert.equal(deriveAppCardState(availability(), ['disabled']), 'paused')
  assert.equal(deriveAppCardState(availability(), ['disabled', 'disabled']), 'paused')
  // Reaching the `disabled` availability verdict from here would strand the one
  // person who could switch it back on: the card owes them Manage, not "Unavailable".
  assert.equal(
    deriveAppCardState(availability({ blocked: true, deprecated: true, locked: true }), ['disabled']),
    'paused',
  )
})

test('availability never overrides a connection this caller already holds', () => {
  // Locking is an install-time gate; an existing connection keeps working, so
  // painting it "Unavailable" would state something false and hide Manage.
  const hostile = availability({
    blocked: true,
    deprecated: true,
    locked: true,
    serverUnreachable: true,
  })
  assert.equal(deriveAppCardState(hostile, ['connected']), 'connected')
  assert.equal(deriveAppCardState(hostile, ['error']), 'error')
})
