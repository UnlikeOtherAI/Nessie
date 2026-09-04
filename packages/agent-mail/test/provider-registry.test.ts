import assert from 'node:assert/strict'
import test from 'node:test'

import { MAILBOX_ISPDB, ispdbForDomain } from '../src/mailbox-ispdb.js'
import { MAILBOX_PROVIDER_REGISTRY, providerForMx } from '../src/provider-registry.js'

const registryDomains = new Set(
  MAILBOX_PROVIDER_REGISTRY.flatMap((entry) => entry.domains),
)

test('every ISPDB entry is structurally valid and carries a re-verifiable reference', () => {
  assert.ok(MAILBOX_ISPDB.length > 0, 'the snapshot must not be empty')

  for (const entry of MAILBOX_ISPDB) {
    const where = entry.domains[0] ?? entry.displayName
    assert.ok(entry.displayName.trim().length > 0, `${where}: displayName must be shown to a person`)
    assert.ok(entry.domains.length > 0, `${where}: an entry configures at least one domain`)

    for (const domain of entry.domains) {
      assert.equal(domain, domain.toLowerCase(), `${domain}: domains are stored lowercase`)
      assert.ok(domain.includes('.'), `${domain}: must be a mail domain, not a label`)
      assert.doesNotMatch(domain, /\s|@/, `${domain}: a domain is never an address`)
    }

    for (const endpoint of [entry.config.imap, entry.config.smtp]) {
      assert.equal(endpoint.host, endpoint.host.toLowerCase(), `${where}: hosts are stored lowercase`)
      assert.ok(endpoint.host.includes('.'), `${where}: ${endpoint.host} must be a hostname`)
      assert.ok(
        Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535,
        `${where}: port ${endpoint.port} is out of range`,
      )
      assert.ok(['tls', 'starttls'].includes(endpoint.security), `${where}: TLS is mandatory`)
    }

    const reference = new URL(entry.reference)
    assert.equal(reference.protocol, 'https:', `${where}: a reference is fetched over HTTPS`)
    assert.ok(reference.hostname.length > 0, `${where}: a reference names a host`)
    assert.match(entry.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${where}: verifiedOn is an ISO date`)
    assert.ok(
      Number.isFinite(Date.parse(entry.verifiedOn)),
      `${where}: verifiedOn ${entry.verifiedOn} does not parse`,
    )
  }
})

test('no domain is claimed twice, and the reviewed registry always wins', () => {
  const seen = new Map<string, string>()

  for (const entry of MAILBOX_ISPDB) {
    for (const domain of entry.domains) {
      const previous = seen.get(domain)
      assert.equal(previous, undefined, `${domain}: claimed by both ${previous} and ${entry.displayName}`)
      seen.set(domain, entry.displayName)

      assert.equal(
        registryDomains.has(domain),
        false,
        `${domain}: a provider-registry domain must not be re-declared in the ISPDB snapshot`,
      )
    }
  }
})

test('ispdbForDomain resolves a snapshot domain and stays undefined for anything else', () => {
  const gmx = ispdbForDomain('gmx.net')
  assert.equal(gmx?.displayName, 'GMX')
  assert.equal(gmx?.config.imap.host, 'imap.gmx.net')
  assert.equal(gmx?.config.imap.port, 993)
  assert.equal(gmx?.config.imap.security, 'tls')
  assert.equal(gmx?.config.smtp.host, 'mail.gmx.net')
  assert.equal(gmx?.config.smtp.port, 465)
  assert.equal(gmx?.config.smtp.security, 'tls')

  const webDe = ispdbForDomain('web.de')
  assert.equal(webDe?.config.username, 'local_part')

  assert.equal(ispdbForDomain('example.invalid'), undefined)
  assert.equal(ispdbForDomain('GMX.NET'), undefined, 'lookups take an already-canonical domain')
  assert.equal(ispdbForDomain('gmail.com'), undefined, 'a registry provider is not an ISPDB entry')
})

test('providerForMx classifies the broadened Microsoft delivery hostnames', () => {
  const microsoft = ['contoso-com.mail.protection.outlook.com', 'contoso-com.mx.microsoft']
  for (const exchange of microsoft) {
    assert.equal(providerForMx(exchange)?.family, 'microsoft', exchange)
  }

  const government = ['contoso-com.mail.protection.office365.us', 'contoso-com.usgovcloud-mx.microsoft']
  for (const exchange of government) {
    assert.equal(providerForMx(exchange)?.family, 'microsoft', exchange)
  }

  assert.equal(providerForMx('CONTOSO-COM.MX.MICROSOFT.')?.family, 'microsoft')
  assert.equal(providerForMx('aspmx.l.google.com')?.family, 'google')
  assert.equal(providerForMx('smtp.google.com')?.family, 'google')
  assert.equal(providerForMx('in1-smtp.messagingengine.com')?.family, 'fastmail')
  assert.equal(providerForMx('mx.zoho.com')?.family, 'zoho')
  assert.equal(providerForMx('mx01.mail.icloud.com')?.family, 'apple')
  assert.equal(providerForMx('mta5.am0.yahoodns.net')?.family, 'yahoo')
  assert.equal(providerForMx('mx.example.invalid'), undefined)
  assert.equal(providerForMx('notmx.microsoft.invalid'), undefined)
})
