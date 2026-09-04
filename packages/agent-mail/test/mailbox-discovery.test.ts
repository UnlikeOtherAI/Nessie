import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMailboxDiscoveryService,
} from '../src/mailbox-discovery.js'
import type { MailboxCapabilityProbe, MailboxProbeOutcome } from '../src/mailbox-probe.js'

/**
 * Discovery is exercised with every outside seam injected — DNS, HTTPS **and**
 * the capability probe. The probe is the only part of discovery that can open a
 * socket, so a test that let it default to the real implementation would dial
 * whatever a fixture named. Every `createMailboxDiscoveryService` call below
 * therefore passes a `probe`, and the default stub answers `unreachable`, which
 * is defined to leave a result exactly as it was.
 */

/** Records what was probed so a test can assert the probe saw the selected config. */
const stubProbe = (outcome: MailboxProbeOutcome = 'unreachable'): MailboxCapabilityProbe & {
  calls: { host: string; port: number; clientName: string }[]
} => {
  const calls: { host: string; port: number; clientName: string }[] = []
  const probe = async (
    config: Parameters<MailboxCapabilityProbe>[0],
    options: Parameters<MailboxCapabilityProbe>[1],
  ): Promise<MailboxProbeOutcome> => {
    calls.push({ clientName: options.clientName, host: config.imap.host, port: config.imap.port })
    return outcome
  }
  return Object.assign(probe, { calls })
}

const service = (input: {
  capabilities?: { appleAuthorization?: boolean; google?: boolean; jmap?: boolean; microsoft?: boolean }
  mx?: string[]
  probe?: MailboxCapabilityProbe
  srv?: Record<string, { name: string; port: number; priority: number; weight: number }[]>
  xml?: string
  jmap?: string
}) => createMailboxDiscoveryService({
  capabilities: input.capabilities,
  dns: {
    mx: async () => (input.mx ?? []).map((exchange) => ({ exchange, priority: 10 })),
    srv: async (name) => input.srv?.[name] ?? [],
  },
  fetch: async (url) => {
    if (url.pathname.endsWith('config-v1.1.xml') && input.xml) return new Response(input.xml)
    if (url.pathname.endsWith('/.well-known/jmap') && input.jmap) return new Response(input.jmap)
    return new Response(null, { status: 404 })
  },
  probe: input.probe ?? stubProbe(),
})

test('reviewed Gmail, Outlook, and iCloud domains take a network-free provider path', async () => {
  const immediate = createMailboxDiscoveryService({
    capabilities: { google: true, microsoft: true },
    dns: {
      mx: async () => { throw new Error('exact provider discovery must not query DNS') },
      srv: async () => { throw new Error('exact provider discovery must not query DNS') },
    },
    fetch: async () => { throw new Error('exact provider discovery must not fetch') },
    probe: async () => { throw new Error('the reviewed registry path must not dial anything') },
  })

  const gmail = await immediate('Name@GMAIL.COM')
  assert.equal(gmail.email, 'Name@gmail.com')
  assert.equal(gmail.provider, 'google')
  assert.equal(gmail.authentication.strategy, 'oauth2')
  assert.equal(gmail.preferredConnector.type, 'gmail_api')

  const outlook = await immediate('person@outlook.com')
  assert.equal(outlook.provider, 'microsoft')
  assert.equal(outlook.authentication.strategy, 'oauth2')
  assert.equal(outlook.preferredConnector.type, 'microsoft_graph')

  const iCloud = await immediate('person@icloud.com')
  assert.equal(iCloud.provider, 'apple')
  assert.equal(iCloud.authentication.strategy, 'app_password')
  assert.equal(iCloud.trustedImapSmtp?.imap.host, 'imap.mail.me.com')
})

test('unconfigured Google OAuth stays visibly unavailable and keeps IMAP behind advanced setup', async () => {
  const result = await service({})('person@gmail.com')
  assert.equal(result.authentication.strategy, 'oauth2')
  assert.equal(result.authentication.available, false)
  assert.equal(result.authentication.unavailableReason, 'not_configured')
  assert.equal(result.preferredConnector.type, 'gmail_api')
  assert.equal(result.preferredConnector.available, false)
  assert.equal(result.ui.requiresAdvancedSettings, true)
})

test('an MX fingerprint classifies a custom Google domain but cannot trust a password destination', async () => {
  const result = await service({
    capabilities: { google: true },
    mx: ['aspmx.l.google.com'],
  })('person@company.example')

  assert.equal(result.provider, 'google')
  assert.equal(result.authentication.strategy, 'oauth2')
  assert.equal(result.ui.requiresProviderConfirmation, false)
  assert.equal(result.credentialDestinationTrust < 0.5, true)
  assert.equal(result.trustedImapSmtp, undefined)
})

test('a sole reviewed Microsoft MX fingerprint takes the configured Graph OAuth path', async () => {
  const result = await service({
    capabilities: { microsoft: true },
    mx: ['company-example.mail.protection.outlook.com'],
  })('person@company.example')

  assert.equal(result.provider, 'microsoft')
  assert.equal(result.authentication.strategy, 'oauth2')
  assert.equal(result.preferredConnector.type, 'microsoft_graph')
  assert.equal(result.ui.requiresProviderConfirmation, false)
  assert.equal(result.trustedImapSmtp, undefined)
})

test('same-domain secure SRV records return a password-only IMAP/SMTP configuration', async () => {
  const result = await service({
    srv: {
      '_imaps._tcp.mail.example': [{ name: 'imap.mail.example', port: 993, priority: 0, weight: 0 }],
      '_submissions._tcp.mail.example': [{ name: 'smtp.mail.example', port: 465, priority: 0, weight: 0 }],
    },
  })('person@mail.example')

  assert.equal(result.provider, 'generic')
  assert.equal(result.authentication.strategy, 'password')
  assert.equal(result.trustedImapSmtp?.imap.security, 'tls')
  assert.equal(result.trustedImapSmtp?.smtp.host, 'smtp.mail.example')
})

test('an external SRV target never becomes a credential destination without corroboration', async () => {
  const result = await service({
    srv: {
      '_imaps._tcp.company.example': [{ name: 'imap.partner.example', port: 993, priority: 0, weight: 0 }],
      '_submissions._tcp.company.example': [{ name: 'smtp.partner.example', port: 465, priority: 0, weight: 0 }],
    },
  })('person@company.example')

  assert.equal(result.authentication.strategy, 'manual')
  assert.equal(result.credentialDestinationTrust, 0)
  assert.equal(result.trustedImapSmtp, undefined)
  assert.equal(result.ui.requiresProviderConfirmation, true)
})

test('domain-controlled autoconfig yields trusted generic settings without revealing XML details', async () => {
  const result = await service({
    xml: `<?xml version="1.0"?><clientConfig><emailProvider><incomingServer type="imap"><hostname>imap.mail.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer><outgoingServer type="smtp"><hostname>smtp.mail.example</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></outgoingServer></emailProvider></clientConfig>`,
  })('person@mail.example')

  assert.equal(result.preferredConnector.type, 'imap_smtp')
  assert.equal(result.trustedImapSmtp?.username, 'local_part')
  assert.equal(result.evidence.some((item) => item.source === 'autoconfig'), true)
})

test('autoconfig rejects arbitrary username templates and registry endpoint security mismatches', async () => {
  const customUsername = await service({
    xml: `<clientConfig><emailProvider><incomingServer type="imap"><hostname>imap.mail.example</hostname><port>993</port><socketType>SSL</socketType><username>person</username></incomingServer><outgoingServer type="smtp"><hostname>smtp.mail.example</hostname><port>465</port><socketType>SSL</socketType><username>person</username></outgoingServer></emailProvider></clientConfig>`,
  })('person@mail.example')
  assert.equal(customUsername.authentication.strategy, 'manual')

  const alteredSecurity = await service({
    xml: `<clientConfig><emailProvider><incomingServer type="imap"><hostname>outlook.office365.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.office365.com</hostname><port>587</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`,
  })('person@company.example')
  assert.equal(alteredSecurity.authentication.strategy, 'manual')
})

test('private autoconfig targets and XML entities are ignored', async () => {
  const privateTarget = await service({
    xml: `<clientConfig><emailProvider><incomingServer type="imap"><hostname>127.0.0.1</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.mail.example</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`,
  })('person@mail.example')
  assert.equal(privateTarget.authentication.strategy, 'manual')

  const entity = await service({
    xml: `<!DOCTYPE clientConfig [<!ENTITY xxe SYSTEM "https://internal.example/">]><clientConfig><emailProvider><incomingServer type="imap"><hostname>&xxe;</hostname><port>993</port><socketType>SSL</socketType></incomingServer></emailProvider></clientConfig>`,
  })('person@mail.example')
  assert.equal(entity.authentication.strategy, 'manual')
})

test('contradictory provider evidence stays ambiguous instead of selecting an OAuth provider', async () => {
  const result = await service({
    mx: ['aspmx.l.google.com'],
    xml: `<clientConfig><emailProvider><incomingServer type="imap"><hostname>outlook.office365.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.office365.com</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`,
  })('person@company.example')

  assert.equal(result.provider, 'unknown')
  assert.equal(result.authentication.strategy, 'manual')
  assert.equal(result.ui.requiresProviderConfirmation, true)
  assert.equal(result.evidence.some((item) => item.source === 'conflict'), true)
})

test('a valid JMAP SRV target is fetched at its discovered port and selected only when supported', async () => {
  const requests: string[] = []
  const discovered = createMailboxDiscoveryService({
    capabilities: { jmap: true },
    dns: {
      mx: async () => [],
      srv: async (name) => name === '_jmap._tcp.mail.example'
        ? [{ name: 'jmap.mail.example', port: 8443, priority: 0, weight: 0 }]
        : [],
    },
    fetch: async (url) => {
      requests.push(url.toString())
      return new Response(JSON.stringify({ apiUrl: 'https://jmap.mail.example:8443/api/' }))
    },
    probe: stubProbe(),
  })
  const result = await discovered('person@mail.example')
  assert.equal(requests.includes('https://jmap.mail.example:8443/.well-known/jmap'), true)
  assert.equal(result.preferredConnector.type, 'jmap')
  assert.equal(result.preferredConnector.available, true)
})

test('reviewed Exchange Autodiscover SRV is provider evidence only', async () => {
  const result = await service({
    capabilities: { microsoft: true },
    srv: {
      '_autodiscover._tcp.company.example': [{ name: 'autodiscover.outlook.com', port: 443, priority: 0, weight: 0 }],
    },
  })('person@company.example')
  assert.equal(result.provider, 'microsoft')
  assert.equal(result.preferredConnector.type, 'microsoft_graph')
  assert.equal(result.trustedImapSmtp, undefined)
  assert.equal(result.evidence.some((item) => item.source === 'autodiscover_srv'), true)
})

test('an unavailable JMAP adapter never falls through to password collection', async () => {
  const result = await service({
    jmap: JSON.stringify({ apiUrl: 'https://jmap.mail.example/api/' }),
  })('person@mail.example')
  assert.equal(result.authentication.strategy, 'manual')
  assert.equal(result.preferredConnector.type, 'manual')
  assert.equal(result.ui.requiresManualSettings, true)
})

test('an unknown domain resolves to the manual recovery path', async () => {
  const result = await service({})('person@unknown.example')
  assert.equal(result.provider, 'generic')
  assert.equal(result.authentication.strategy, 'manual')
  assert.equal(result.ui.requiresManualSettings, true)
})

test('a timed-out DNS resolver falls back without holding discovery open', async () => {
  const result = await createMailboxDiscoveryService({
    dns: {
      mx: async () => new Promise(() => undefined),
      srv: async () => new Promise(() => undefined),
    },
    fetch: async () => new Response(null, { status: 404 }),
    probe: stubProbe(),
    timeout: async () => null,
  })('person@unknown.example')
  assert.equal(result.authentication.strategy, 'manual')
})

test('a curated snapshot domain yields a password-only result under the provider’s own name', async () => {
  const probe = stubProbe()
  const result = await service({ probe })('person@posteo.de')

  assert.equal(result.provider, 'generic')
  assert.equal(result.ui.providerName, 'Posteo')
  assert.equal(result.authentication.strategy, 'password')
  assert.equal(result.preferredConnector.type, 'imap_smtp')
  assert.equal(result.configurationConfidence, 0.9)
  assert.equal(result.credentialDestinationTrust, 0.95)
  assert.deepEqual(result.trustedImapSmtp, {
    imap: { host: 'posteo.de', port: 993, security: 'tls' },
    smtp: { host: 'posteo.de', port: 465, security: 'tls' },
    username: 'email_address',
  })
  // Password-only: the person types a password, never a server name.
  assert.equal(result.ui.requiresManualSettings, false)
  assert.equal(result.ui.requiresAdvancedSettings, false)
  assert.equal(result.ui.requiresProviderConfirmation, false)
  assert.equal(result.evidence.some((item) => item.source === 'ispdb'), true)
  assert.deepEqual(probe.calls, [{ clientName: 'posteo.de', host: 'posteo.de', port: 993 }])
})

test('a domain-controlled autoconfig document outranks the curated snapshot for its own domain', async () => {
  const result = await service({
    xml: `<clientConfig><emailProvider><incomingServer type="imap"><hostname>imap.posteo.de</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.posteo.de</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`,
  })('person@posteo.de')

  // The snapshot is a candidate, not a short circuit: it was found, and lost.
  assert.equal(result.evidence.some((item) => item.source === 'ispdb'), true)
  assert.equal(result.evidence.some((item) => item.source === 'autoconfig'), true)
  assert.equal(result.trustedImapSmtp?.imap.host, 'imap.posteo.de')
  assert.equal(result.trustedImapSmtp?.smtp.port, 587)
  assert.equal(result.ui.providerName, 'Email provider')
})

test('a confirmed capability probe raises credential trust and is recorded as evidence', async () => {
  const result = await service({ probe: stubProbe('confirmed') })('person@posteo.de')

  assert.equal(result.credentialDestinationTrust, 1)
  assert.equal(result.trustedImapSmtp?.imap.host, 'posteo.de')
  assert.equal(
    result.evidence.some((item) => item.source === 'capability_probe' && item.trustedForCredentials),
    true,
  )
})

test('a configuration the probe cannot reach securely never authorises a password screen', async () => {
  const result = await service({ probe: stubProbe('insecure') })('person@posteo.de')

  assert.equal(result.trustedImapSmtp, undefined)
  assert.equal(result.credentialDestinationTrust, 0)
  assert.equal(result.authentication.strategy, 'manual')
  assert.equal(result.preferredConnector.type, 'manual')
  assert.equal(result.ui.requiresManualSettings, true)
})

test('an unreachable probe leaves a reviewed configuration exactly as it was', async () => {
  const unreachable = await service({ probe: stubProbe('unreachable') })('person@posteo.de')
  assert.equal(unreachable.trustedImapSmtp?.imap.host, 'posteo.de')
  assert.equal(unreachable.credentialDestinationTrust, 0.95)
  assert.equal(unreachable.ui.requiresManualSettings, false)

  const skipped = await service({ probe: stubProbe('skipped') })('person@posteo.de')
  assert.equal(skipped.trustedImapSmtp?.imap.host, 'posteo.de')
  assert.equal(skipped.credentialDestinationTrust, 0.95)
})

test('an untrusted candidate is never probed and never becomes a password destination', async () => {
  const probe = stubProbe('confirmed')
  const result = await service({
    probe,
    srv: {
      '_imaps._tcp.company.example': [{ name: 'imap.partner.example', port: 993, priority: 0, weight: 0 }],
      '_submissions._tcp.company.example': [{ name: 'smtp.partner.example', port: 465, priority: 0, weight: 0 }],
    },
  })('person@company.example')

  assert.deepEqual(probe.calls, [], 'only a candidate discovery already trusts may be dialled')
  assert.equal(result.trustedImapSmtp, undefined)
  assert.equal(result.credentialDestinationTrust, 0)
})
