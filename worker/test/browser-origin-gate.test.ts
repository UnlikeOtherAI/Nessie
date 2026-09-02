import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateOriginGate,
  noteVisitedOrigin,
  originIsAuthenticated,
  type OriginGateState,
} from '../src/run/browser-cloud/origin-gate.js'

/**
 * The gate is the phase-2 hardening for the one attack the disclosure basis
 * cannot see: a hostile page steering the agent to type what it read on a
 * signed-in tab into a form somewhere else, which leaves through the browser's
 * own egress and never touches a Nessie message.
 */

const gateWith = (origins: string[], touched: boolean): OriginGateState => ({
  authenticatedOrigins: new Set(origins),
  touchedAuthenticated: touched,
})

test('an unauthenticated browser is not gated at all', () => {
  const gate = gateWith([], false)
  const verdict = evaluateOriginGate(gate, 'https://anywhere.example.com/', {
    action: 'type',
    nodeId: 1,
    text: 'hello',
  })
  assert.equal(verdict.allowed, true)
})

test('a signed-in browser that has not visited a signed-in site yet is not gated', () => {
  // Ordinary public browsing, even though the browser holds cookies.
  const gate = gateWith(['https://mail.example.com'], false)
  const verdict = evaluateOriginGate(gate, 'https://news.example.org/', {
    action: 'type',
    nodeId: 1,
    text: 'hello',
  })
  assert.equal(verdict.allowed, true)
})

test('typing on the signed-in site itself stays free', () => {
  const gate = gateWith(['https://mail.example.com'], true)
  const verdict = evaluateOriginGate(gate, 'https://mail.example.com/inbox', {
    action: 'type',
    nodeId: 1,
    text: 'a reply',
  })
  // Doing the task on the service you are signed in to is the whole point.
  assert.equal(verdict.allowed, true)
})

test('a subdomain of a signed-in host counts as the same site', () => {
  const gate = gateWith(['https://example.com'], true)
  assert.equal(originIsAuthenticated('https://app.example.com', gate.authenticatedOrigins), true)
  const verdict = evaluateOriginGate(gate, 'https://app.example.com/x', {
    action: 'click',
    nodeId: 2,
  })
  assert.equal(verdict.allowed, true)
})

test('typing on a foreign origin after visiting a signed-in one is refused', () => {
  const gate = gateWith(['https://mail.example.com'], true)
  const verdict = evaluateOriginGate(gate, 'https://attacker.example.net/collect', {
    action: 'type',
    nodeId: 3,
    text: 'secret from the inbox',
  })
  assert.equal(verdict.allowed, false)
  assert.match(
    'reason' in verdict ? verdict.reason : '',
    /not one of them|take control/,
  )
})

test('clicking on a foreign origin is refused too — a submit is a click', () => {
  const gate = gateWith(['https://mail.example.com'], true)
  const verdict = evaluateOriginGate(gate, 'https://attacker.example.net/collect', {
    action: 'click',
    nodeId: 4,
  })
  assert.equal(verdict.allowed, false)
})

test('reads and movement are never gated — narrowing them would kill the capability', () => {
  const gate = gateWith(['https://mail.example.com'], true)
  for (const action of [
    { action: 'navigate' as const, url: 'https://anywhere.example.net/' },
    { action: 'scroll' as const, deltaY: 200 },
    { action: 'press' as const, key: 'PageDown' },
  ]) {
    assert.equal(
      evaluateOriginGate(gate, 'https://anywhere.example.net/', action).allowed,
      true,
      `${action.action} must stay allowed`,
    )
  }
})

test('visiting a signed-in origin arms the gate', () => {
  const gate = gateWith(['https://mail.example.com'], false)
  noteVisitedOrigin(gate, 'https://news.example.org/')
  assert.equal(gate.touchedAuthenticated, false)
  noteVisitedOrigin(gate, 'https://mail.example.com/inbox')
  assert.equal(gate.touchedAuthenticated, true)
})
