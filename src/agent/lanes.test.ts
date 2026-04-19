/**
 * src/agent/lanes.test.ts — Unit tests for nested lane isolation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNestedAgentLaneForSession, isNestedAgentLane } from './lanes.js'

// ─── resolveNestedAgentLaneForSession ────────────────────────────────────────

test('resolveNestedAgentLaneForSession: null → "nested"', () => {
  assert.equal(resolveNestedAgentLaneForSession(null), 'nested')
})

test('resolveNestedAgentLaneForSession: undefined → "nested"', () => {
  assert.equal(resolveNestedAgentLaneForSession(undefined), 'nested')
})

test('resolveNestedAgentLaneForSession: empty string → "nested"', () => {
  assert.equal(resolveNestedAgentLaneForSession(''), 'nested')
})

test('resolveNestedAgentLaneForSession: whitespace-only → "nested"', () => {
  assert.equal(resolveNestedAgentLaneForSession('   '), 'nested')
})

test('resolveNestedAgentLaneForSession: whitespace-only with tabs/newlines → "nested"', () => {
  assert.equal(resolveNestedAgentLaneForSession('\t\n  \t\n'), 'nested')
})

test('resolveNestedAgentLaneForSession: valid session key → "nested:<key>"', () => {
  assert.equal(resolveNestedAgentLaneForSession('agent:main:cron:abc123'), 'nested:agent:main:cron:abc123')
})

test('resolveNestedAgentSession: simple session key → "nested:<key>"', () => {
  assert.equal(resolveNestedAgentLaneForSession('session-42'), 'nested:session-42')
})

test('resolveNestedAgentLaneForSession: session key with surrounding whitespace → trimmed and scoped', () => {
  assert.equal(resolveNestedAgentLaneForSession('  agent:main:cron:abc123  '), 'nested:agent:main:cron:abc123')
})

// ─── isNestedAgentLane ────────────────────────────────────────────────────────

test('isNestedAgentLane: "nested" → true', () => {
  assert.equal(isNestedAgentLane('nested'), true)
})

test('isNestedAgentLane: "nested:foo" → true', () => {
  assert.equal(isNestedAgentLane('nested:foo'), true)
})

test('isNestedAgentLane: "nested:agent:main:cron:abc123" → true', () => {
  assert.equal(isNestedAgentLane('nested:agent:main:cron:abc123'), true)
})

test('isNestedAgentLane: "nestedfoo" (no colon) → false', () => {
  assert.equal(isNestedAgentLane('nestedfoo'), false)
})

test('isNestedAgentLane: "nestedfoobar" (no colon) → false', () => {
  assert.equal(isNestedAgentLane('nestedfoobars'), false)
})

test('isNestedAgentLane: "main" → false', () => {
  assert.equal(isNestedAgentLane('main'), false)
})

test('isNestedAgentLane: "cron" → false', () => {
  assert.equal(isNestedAgentLane('cron'), false)
})

test('isNestedAgentLane: "subagent" → false', () => {
  assert.equal(isNestedAgentLane('subagent'), false)
})

test('isNestedAgentLane: undefined → false', () => {
  assert.equal(isNestedAgentLane(undefined), false)
})

test('isNestedAgentLane: empty string → false', () => {
  assert.equal(isNestedAgentLane(''), false)
})

test('isNestedAgentLane: " Nested" (wrong casing) → false', () => {
  assert.equal(isNestedAgentLane(' Nested'), false)
})

// ─── Integration: round-trip resolution ──────────────────────────────────────

test('resolveNestedAgentLaneForSession + isNestedAgentLane: valid session key round-trips correctly', () => {
  const sessionKey = 'agent:main:cron:abc123'
  const lane = resolveNestedAgentLaneForSession(sessionKey)
  assert.equal(isNestedAgentLane(lane), true)
})

test('resolveNestedAgentLaneForSession + isNestedAgentLane: null key round-trips correctly', () => {
  const lane = resolveNestedAgentLaneForSession(null)
  assert.equal(isNestedAgentLane(lane), true)
})