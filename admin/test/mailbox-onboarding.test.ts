import assert from 'node:assert/strict'
import test from 'node:test'

import type { MailboxDiscoveryResult } from '../src/lib/api-client.js'
import { connectionAnchorId } from '../src/lib/connection-anchor.js'
import { mailboxDiscoveryRequest } from '../src/facades/mailbox-connections/hooks.js'
import {
  commsOAuthProvider,
  appPasswordAccountName,
  hasTrustedMailboxConfiguration,
  isUsableEmailAddress,
  mailboxErrorMessage,
  nextMailboxOnboardingStep,
  providerIcon,
  shouldDiscoverMailbox,
} from '../src/components/features/mailbox-connections/mailbox-onboarding.js'

const discovery = (overrides: Partial<MailboxDiscoveryResult> = {}): MailboxDiscoveryResult => ({
  authentication: { available: false, strategy: 'manual', unavailableReason: null },
  configurationConfidence: 0,
  credentialDestinationTrust: 0,
  domain: 'example.com',
  email: 'name@example.com',
  evidence: [],
  fallbackConnectors: [],
  preferredConnector: { available: false, type: 'manual', unavailableReason: null },
  provider: 'generic',
  ui: {
    providerIcon: 'generic',
    providerName: 'Example Mail',
    requiresAdvancedSettings: false,
    requiresManualSettings: false,
    requiresProviderConfirmation: false,
  },
  ...overrides,
})

test('Continue only accepts a syntactically usable email address', () => {
  assert.equal(isUsableEmailAddress('person@example.com'), true)
  assert.equal(isUsableEmailAddress('person@localhost'), false)
  assert.equal(isUsableEmailAddress('not an address'), false)
})

test('discovery omits an absent team id from the strict request body', () => {
  assert.deepEqual(mailboxDiscoveryRequest({
    email: 'person@example.com',
    scope: 'user',
  }), {
    email: 'person@example.com',
    scope: 'user',
  })
  assert.deepEqual(mailboxDiscoveryRequest({
    email: 'support@example.com',
    scope: 'team',
    teamId: '6a7f5e1c-1d7b-4aa5-8b0f-01951a8ce3ad',
  }), {
    email: 'support@example.com',
    scope: 'team',
    teamId: '6a7f5e1c-1d7b-4aa5-8b0f-01951a8ce3ad',
  })
})

test('a provider label does not imply personal OAuth is available', () => {
  const unavailableGoogle = discovery({
    authentication: { available: false, strategy: 'oauth2', unavailableReason: 'not_configured' },
    provider: 'google',
  })
  assert.equal(commsOAuthProvider(unavailableGoogle, 'user'), null)

  const availableGoogle = discovery({
    authentication: { available: true, strategy: 'oauth2', unavailableReason: null },
    provider: 'google',
  })
  assert.equal(commsOAuthProvider(availableGoogle, 'user'), 'google')
  assert.equal(commsOAuthProvider(availableGoogle, 'team'), null)
})

test('the server-owned trusted configuration is enough for the credential path', () => {
  const trusted = discovery({
    trustedImapSmtp: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' },
      username: 'local_part',
    },
  })
  assert.equal(hasTrustedMailboxConfiguration(trusted), true)
})

test('unavailable native OAuth requires an explicit advanced-settings choice', () => {
  const unavailableNative = discovery({
    authentication: { available: false, strategy: 'oauth2', unavailableReason: 'not_configured' },
    provider: 'microsoft',
    trustedImapSmtp: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' },
      username: 'email_address',
    },
    ui: {
      providerIcon: 'microsoft',
      providerName: 'Microsoft',
      requiresAdvancedSettings: true,
      requiresManualSettings: false,
      requiresProviderConfirmation: false,
    },
  })

  assert.equal(nextMailboxOnboardingStep(unavailableNative, 'user'), 'shared-credential')
})

test('native OAuth remains personal even when a team result includes a fallback', () => {
  const nativeGoogle = discovery({
    authentication: { available: true, strategy: 'oauth2', unavailableReason: null },
    provider: 'google',
    trustedImapSmtp: {
      imap: { host: 'imap.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' },
      username: 'email_address',
    },
  })
  assert.equal(nextMailboxOnboardingStep(nativeGoogle, 'user'), 'start')
  assert.equal(nextMailboxOnboardingStep(nativeGoogle, 'team'), 'shared-credential')
})

test('an existing discovered connection stops before any authentication route', () => {
  const existingNative = discovery({
    authentication: { available: true, strategy: 'oauth2', unavailableReason: null },
    existingConnection: { id: 'native-connection', kind: 'comms_connection' },
    provider: 'google',
  })
  assert.equal(nextMailboxOnboardingStep(existingNative, 'user'), 'existing')
})

test('only the address-first screen launches background discovery', () => {
  assert.equal(shouldDiscoverMailbox('start'), true)
  assert.equal(shouldDiscoverMailbox('password'), false)
  assert.equal(shouldDiscoverMailbox('manual'), false)
})

test('connection errors name the remedy without blaming an unclassified test failure', () => {
  assert.equal(
    mailboxErrorMessage({ code: 'CREDENTIAL_REJECTED' }, 'Could not connect this mailbox.'),
    'Your email address or password was not accepted.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'INVALID_CERTIFICATE' }, 'Could not connect this mailbox.'),
    'We cannot connect securely to this mail server.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'SERVER_UNAVAILABLE' }, 'Could not connect this mailbox.'),
    'We found your email settings, but could not connect to the server.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'TEST_FAILED' }, 'Could not connect this mailbox.'),
    'Could not complete the mailbox connection test.',
  )
})

test('app-password guidance names the detected provider account', () => {
  const fastmail = discovery({
    authentication: { available: true, strategy: 'app_password', unavailableReason: null },
    provider: 'fastmail',
    ui: {
      providerIcon: 'fastmail',
      providerName: 'Fastmail',
      requiresAdvancedSettings: false,
      requiresManualSettings: false,
      requiresProviderConfirmation: false,
    },
  })
  assert.equal(appPasswordAccountName(fastmail), 'Fastmail account')
  assert.equal(appPasswordAccountName(discovery({ provider: 'apple' })), 'Apple Account')
})

test('existing native and live connection results share one reachable anchor', () => {
  const native = discovery({
    existingConnection: { id: 'native-connection', kind: 'comms_connection' },
  })
  const live = discovery({
    existingConnection: { id: 'live-connection', kind: 'mailbox_connection', scope: 'user' },
  })
  assert.equal(
    connectionAnchorId(native.existingConnection?.id ?? ''),
    'connection-native-connection',
  )
  assert.equal(
    connectionAnchorId(live.existingConnection?.id ?? ''),
    'connection-live-connection',
  )
})

test('a provider mark is a brand icon, and an unknown provider gets the envelope', () => {
  assert.equal(providerIcon('google').iconName, 'google')
  assert.equal(providerIcon('microsoft').iconName, 'microsoft')
  // The address screen labels the row iCloud; discovery calls the same brand
  // apple. Both must land on the same mark.
  assert.equal(providerIcon('icloud').iconName, providerIcon('apple').iconName)
  assert.equal(providerIcon('yahoo').iconName, 'yahoo')
  // Every discovery icon without a brand mark, and anything unrecognised,
  // falls back rather than rendering an initial next to real logos.
  assert.equal(providerIcon('fastmail').iconName, 'envelope')
  assert.equal(providerIcon('zoho').iconName, 'envelope')
  assert.equal(providerIcon('generic').iconName, 'envelope')
  assert.equal(providerIcon('nothing-like-this').iconName, 'envelope')
})

test('a deployment that never configured a provider does not invite a retry', () => {
  assert.equal(
    mailboxErrorMessage({ code: 'PROVIDER_NOT_CONFIGURED' }, 'Connection was not started.'),
    'Sign-in with this provider has not been set up on this Nessie server. '
      + 'An administrator has to register it first.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'NOT_IMPLEMENTED' }, 'Connection was not started.'),
    'Connecting this provider is not available yet.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'PUBLIC_ORIGIN_NOT_CONFIGURED' }, 'Connection was not started.'),
    'This server does not know its own public address, so sign-in cannot start. '
      + 'An administrator has to set it.',
  )
})
