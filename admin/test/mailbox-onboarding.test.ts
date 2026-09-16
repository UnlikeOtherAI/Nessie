import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  MailboxConnectionDiagnosis,
  MailboxDiscoveryResult,
} from '../src/lib/api-client.js'
import { connectionAnchorId } from '../src/lib/connection-anchor.js'
import { mailboxDiscoveryRequest } from '../src/facades/mailbox-connections/hooks.js'
import {
  commsOAuthProvider,
  failingLeg,
  mailboxConnectionDiagnosis,
  nextStepAfterConnectFailure,
  appPasswordAccountName,
  appPasswordPageUrl,
  appPasswordPages,
  hasTrustedMailboxConfiguration,
  isUsableEmailAddress,
  mailboxAddressDomain,
  mailboxErrorCode,
  mailboxErrorMessage,
  mailboxTechnicalDetails,
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

test('an abandoned or refused sign-in is explained, never left as a raw failure', () => {
  const fallback = 'Could not connect this mailbox.'
  assert.equal(
    mailboxErrorMessage({ code: 'OAUTH_CANCELLED' }, fallback),
    'Connection wasn\'t completed.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'access_denied' }, fallback),
    'We need permission to access your email to connect this account.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'ADMIN_BLOCKED' }, fallback),
    'Your organisation doesn\'t currently allow this app to access email.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'APP_PASSWORD_REQUIRED' }, fallback),
    'This provider requires an app-specific password.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'RATE_LIMITED' }, fallback),
    'Your email provider is temporarily unavailable.',
  )
  assert.equal(
    mailboxErrorMessage({ code: 'PROVIDER_UNAVAILABLE' }, fallback),
    'Your email provider is temporarily unavailable.',
  )
  assert.equal(mailboxErrorMessage({ code: 'SOMETHING_NEW' }, fallback), fallback)
  assert.equal(mailboxErrorMessage(new Error('offline'), fallback), fallback)
})

test('a mail-server outage keeps its own copy, distinct from a provider outage', () => {
  const fallback = 'Could not connect this mailbox.'
  assert.equal(
    mailboxErrorMessage({ code: 'SERVER_UNAVAILABLE' }, fallback),
    'We found your email settings, but could not connect to the server.',
  )
})

test('a quotable error code is sanitised, never echoed as the server wrote it', () => {
  assert.equal(mailboxErrorCode({ code: 'access-denied' }), 'ACCESS_DENIED')
  assert.equal(mailboxErrorCode({ code: '  consent denied  ' }), 'CONSENT_DENIED')
  assert.equal(mailboxErrorCode({ code: '<b>oops</b>' }), 'B_OOPS_B')
  assert.equal(mailboxErrorCode({ code: '' }), null)
  assert.equal(mailboxErrorCode(new Error('offline')), null)
  assert.equal(mailboxErrorCode(null), null)
  assert.equal(mailboxErrorCode({ code: 'A'.repeat(200) })?.length, 64)
})

test('an app-password screen links only to a verified provider page', () => {
  assert.equal(
    appPasswordPageUrl(discovery({ provider: 'apple' })),
    'https://account.apple.com',
  )
  assert.equal(
    appPasswordPageUrl(discovery({ provider: 'google' })),
    'https://myaccount.google.com/apppasswords',
  )
  assert.equal(
    appPasswordPageUrl(discovery({ provider: 'fastmail' })),
    'https://app.fastmail.com/settings/security',
  )
  assert.equal(
    appPasswordPageUrl(discovery({ provider: 'yahoo' })),
    'https://login.yahoo.com/account/security',
  )
  assert.equal(appPasswordPageUrl(discovery({ provider: 'zoho' })), 'https://accounts.zoho.com')

  // Unverified providers get guidance without a link rather than a guess.
  assert.equal(appPasswordPageUrl(discovery({ provider: 'generic' })), null)
  assert.equal(appPasswordPageUrl(discovery({ provider: 'unknown' })), null)
  assert.equal(appPasswordPageUrl(discovery({ provider: 'microsoft' })), null)
  for (const url of Object.values(appPasswordPages)) {
    assert.equal(String(url).startsWith('https://'), true)
  }
})

test('technical details carry the domain and the evidence, never the person', () => {
  const lines = mailboxTechnicalDetails({
    address: 'accounts.payable@example.com',
    code: 'DISCOVERY_FAILED',
    result: discovery({
      configurationConfidence: 0.82,
      credentialDestinationTrust: 0.4,
      evidence: [
        { provider: 'generic', score: 60, source: 'provider_registry', trustedForCredentials: true },
        { score: 20, source: 'mx_fingerprint', trustedForCredentials: false },
      ],
    }),
  })

  assert.deepEqual(lines, [
    'Error code: DISCOVERY_FAILED',
    'Domain: example.com',
    'Configuration confidence: 82%',
    'Credential destination trust: 40%',
    'Evidence: provider_registry 60 trusted, mx_fingerprint 20',
  ])
  assert.equal(lines.some((line) => line.includes('accounts.payable')), false)
})

test('technical details still name the domain when discovery never returned', () => {
  assert.deepEqual(
    mailboxTechnicalDetails({ address: 'person@Example.COM', code: 'TEST_FAILED', result: null }),
    ['Error code: TEST_FAILED', 'Domain: example.com'],
  )
  assert.deepEqual(mailboxTechnicalDetails({ address: '', code: null, result: null }), [])
  assert.equal(mailboxAddressDomain('not-an-address'), null)
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

const diagnosis = (
  imap: MailboxConnectionDiagnosis['imap'],
  smtp: MailboxConnectionDiagnosis['smtp'],
): MailboxConnectionDiagnosis => ({ imap, smtp })

const reached = { host: 'imap.example.com', ok: true, port: 993 } as const
const missing = { failure: 'unreachable', host: 'smtp.example.com', ok: false } as const

test('an undiscoverable domain now asks for a password, not for ten server fields', () => {
  const unknown = discovery({
    ui: {
      providerIcon: 'generic',
      providerName: 'Example Mail',
      requiresAdvancedSettings: false,
      // The old behaviour: this alone sent somebody to the advanced form before
      // anything had been tried. The connect route resolves endpoints now.
      requiresManualSettings: true,
      requiresProviderConfirmation: false,
    },
  })
  assert.equal(nextMailboxOnboardingStep(unknown, 'user'), 'password')
})

test('the failing leg is named only when exactly one of them failed', () => {
  assert.equal(failingLeg(diagnosis(reached, missing)), 'smtp')
  assert.equal(failingLeg(diagnosis({ ...missing, host: 'imap.example.com' }, { ...reached, host: 'smtp.example.com' })), 'imap')
  assert.equal(failingLeg(diagnosis(reached, { ...reached, host: 'smtp.example.com' })), null)
  assert.equal(failingLeg(diagnosis({ ...missing }, { ...missing })), null)
})

test('one working leg escalates to that leg alone, never to the whole form', () => {
  assert.equal(nextStepAfterConnectFailure('password', diagnosis(reached, missing)), 'leg')
  assert.equal(nextStepAfterConnectFailure('server', diagnosis(reached, missing)), 'leg')
})

test('the password screen escalates to one mail server before the full form', () => {
  const bothMissing = diagnosis({ failure: 'unreachable', ok: false }, { failure: 'unreachable', ok: false })
  assert.equal(nextStepAfterConnectFailure('password', bothMissing), 'server')
  assert.equal(nextStepAfterConnectFailure('server', bothMissing), 'manual')
})

test('a step never repeats itself: the leg screen escalates to the full form', () => {
  assert.equal(nextStepAfterConnectFailure('leg', diagnosis(reached, missing)), 'manual')
})

test('a rejected credential keeps the person where they are', () => {
  const rejected = diagnosis(
    { failure: 'credential_rejected', ok: false },
    { failure: 'credential_rejected', ok: false },
  )
  // Every other screen would ask them to fix settings that are not broken.
  assert.equal(nextStepAfterConnectFailure('password', rejected), 'password')
  assert.equal(nextStepAfterConnectFailure('leg', rejected), 'leg')
  assert.equal(nextStepAfterConnectFailure('manual', rejected), 'manual')
})

test('a refusal with no diagnosis falls forward rather than stalling', () => {
  assert.equal(nextStepAfterConnectFailure('password', null), 'server')
  assert.equal(nextStepAfterConnectFailure('manual', null), 'manual')
})

test('the diagnosis is parsed off the refusal, and a wrong shape is refused', () => {
  const details = diagnosis(reached, missing)
  assert.deepEqual(mailboxConnectionDiagnosis({ details }), details)
  assert.equal(mailboxConnectionDiagnosis({ details: { imap: 'yes' } }), null)
  assert.equal(mailboxConnectionDiagnosis({ message: 'no details at all' }), null)
  assert.equal(mailboxConnectionDiagnosis(null), null)
})
