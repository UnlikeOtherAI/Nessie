import assert from 'node:assert/strict'
import test from 'node:test'

import type { MailboxDiscoveryResult } from '@nessie/schemas'

import {
  mailboxDiscoveryOutcome,
  mailboxDiscoveryTelemetry,
} from '../src/services/mailbox-discovery-telemetry.js'

/**
 * Discovery is the funnel worth measuring, and a mailbox address is a person.
 * These tests hold both halves: the outcome a run should be counted under, and
 * the guarantee that counting it never writes down whose mailbox it was.
 */

const result = (overrides: Partial<MailboxDiscoveryResult> = {}): MailboxDiscoveryResult => ({
  authentication: { available: true, strategy: 'oauth2', unavailableReason: null },
  configurationConfidence: 0.99,
  credentialDestinationTrust: 1,
  domain: 'example.com',
  email: 'ada.lovelace@example.com',
  evidence: [
    { score: 100, source: 'provider_registry', trustedForCredentials: true },
    { score: 55, source: 'mx_fingerprint', trustedForCredentials: false },
  ],
  fallbackConnectors: [],
  preferredConnector: { available: true, type: 'gmail_api', unavailableReason: null },
  provider: 'google',
  ui: {
    providerIcon: 'google',
    providerName: 'Google',
    requiresAdvancedSettings: false,
    requiresManualSettings: false,
    requiresProviderConfirmation: false,
  },
  ...overrides,
})

test('an available provider sign-in counts as the zero-configuration outcome', () => {
  assert.equal(mailboxDiscoveryOutcome(result()), 'provider_oauth')
})

test('a recognised provider whose adapter is unconfigured is not counted as OAuth', () => {
  // The shape discovery really produces here: Gmail is recognised, so a
  // reviewed IMAP/SMTP fallback rides along, but with no Google adapter
  // configured the person is sent to advanced settings rather than a one-
  // password screen. Counting that as `password` would inflate the best
  // outcome in the funnel, so the fixture carries the configuration the
  // server would actually attach.
  const unconfigured = result({
    authentication: { available: false, strategy: 'oauth2', unavailableReason: 'not_configured' },
    trustedImapSmtp: {
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
      username: 'email_address',
    },
    ui: { ...result().ui, requiresAdvancedSettings: true },
  })
  assert.equal(mailboxDiscoveryOutcome(unconfigured), 'manual')
})

test('a reviewed configuration counts as the password outcome, and its absence as manual', () => {
  const trusted = result({
    authentication: { available: true, strategy: 'password', unavailableReason: null },
    trustedImapSmtp: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
      username: 'email_address',
    },
  })
  assert.equal(mailboxDiscoveryOutcome(trusted), 'password')
  assert.equal(
    mailboxDiscoveryOutcome(result({
      authentication: { available: true, strategy: 'password', unavailableReason: null },
    })),
    'manual',
  )
})

test('confirmation and duplicate outcomes are distinguished from a plain manual fallback', () => {
  const confirmation = result({
    ui: { ...result().ui, requiresProviderConfirmation: true },
  })
  assert.equal(mailboxDiscoveryOutcome(confirmation), 'provider_confirmation')

  const duplicate = result({
    existingConnection: {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'mailbox_connection',
      scope: 'user',
    },
  })
  assert.equal(mailboxDiscoveryOutcome(duplicate), 'existing_connection')

  const nothing = result({
    authentication: { available: true, strategy: 'manual', unavailableReason: null },
    ui: { ...result().ui, requiresManualSettings: true },
  })
  assert.equal(mailboxDiscoveryOutcome(nothing), 'manual')
})

test('confidence is reported as a band rather than the underlying constant', () => {
  const telemetry = mailboxDiscoveryTelemetry(result({
    configurationConfidence: 0.45,
    credentialDestinationTrust: 0,
  }))
  assert.equal(telemetry.configurationConfidence, 'low')
  assert.equal(telemetry.credentialDestinationTrust, 'none')
  assert.equal(
    mailboxDiscoveryTelemetry(result()).configurationConfidence,
    'high',
  )
})

test('evidence sources are reported deduplicated so a regression names its own source', () => {
  const telemetry = mailboxDiscoveryTelemetry(result({
    evidence: [
      { score: 55, source: 'mx_fingerprint', trustedForCredentials: false },
      { score: 90, source: 'autoconfig', trustedForCredentials: true },
      { score: 55, source: 'mx_fingerprint', trustedForCredentials: false },
    ],
  }))
  assert.deepEqual(telemetry.sources, ['autoconfig', 'mx_fingerprint'])
})

test('telemetry carries the domain and never the address it came from', () => {
  const telemetry = mailboxDiscoveryTelemetry(result())
  const serialized = JSON.stringify(telemetry)

  assert.equal(telemetry.domain, 'example.com')
  assert.ok(!serialized.includes('ada.lovelace'), 'local part must never be logged')
  assert.ok(!serialized.includes('@'), 'no field may carry a mailbox address')
  assert.ok(!('email' in telemetry), 'the address is not a telemetry field')
})
