import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyEmailDomain,
  consumerProviderDomains,
  domainOfEmail,
  DOMAIN_REJECTION_MESSAGES,
  normaliseDomain,
  type DomainRejection,
} from '../email-domain.js'

// The stand-in public-suffix oracle. The real one is `tldts`; these cases only
// need the verdict, and injecting it keeps the module pure (see its header).
const PUBLIC_SUFFIXES = new Set(['com', 'net', 'org', 'co.uk', 'github.io', 'com.au'])
const isPublicSuffix = (domain: string): boolean => PUBLIC_SUFFIXES.has(domain)

const rejects = (input: string, reason: DomainRejection): void => {
  const decision = normaliseDomain(input)
  assert.equal(decision.ok, false, `expected ${input} to be rejected`)
  assert.equal(decision.ok === false && decision.reason, reason)
}

const normalisesTo = (input: string, domain: string): void => {
  const decision = normaliseDomain(input)
  assert.equal(decision.ok, true, `expected ${input} to normalise`)
  assert.equal(decision.ok === true && decision.domain, domain)
}

test('normalises case, whitespace and the DNS root dot', () => {
  normalisesTo('Example.COM', 'example.com')
  normalisesTo('  example.com  ', 'example.com')
  normalisesTo('example.com.', 'example.com')
  normalisesTo('sub.example.co.uk', 'sub.example.co.uk')
})

test('folds internationalised domains to punycode', () => {
  normalisesTo('bücher.de', 'xn--bcher-kva.de')
  normalisesTo('BÜCHER.DE', 'xn--bcher-kva.de')
  // Full-width characters fold to the same ASCII form under UTS-46, which is
  // exactly why the stored value — not the raw input — is what gets looked up.
  normalisesTo('ｅｘａｍｐｌｅ.com', 'example.com')
})

test('rejects anything that is not a bare hostname', () => {
  rejects('', 'malformed')
  rejects('   ', 'malformed')
  rejects('.', 'malformed')
  rejects('example.com..', 'malformed')
  rejects('user@example.com', 'malformed')
  rejects('example.com/path', 'malformed')
  rejects('example.com:25', 'malformed')
  rejects('exa mple.com', 'malformed')
  rejects('https://example.com', 'malformed')
  rejects('-example.com', 'malformed')
  rejects('example-.com', 'malformed')
  rejects('example..com', 'malformed')
})

test('rejects IP literals in every shape', () => {
  rejects('127.0.0.1', 'ip_literal')
  rejects('10.0.0.5', 'ip_literal')
  rejects('255.255.255.255', 'ip_literal')
  rejects('::1', 'ip_literal')
  rejects('[::1]', 'ip_literal')
  rejects('[2001:db8::1]', 'ip_literal')
  rejects('fe80::1', 'ip_literal')
})

test('rejects loopback and local-only names', () => {
  rejects('localhost', 'localhost')
  rejects('LOCALHOST', 'localhost')
  rejects('api.localhost', 'localhost')
  rejects('printer.local', 'localhost')
})

test('rejects single labels and oversized names', () => {
  rejects('example', 'single_label')
  rejects('com', 'single_label')
  rejects(`${'a'.repeat(64)}.com`, 'too_long')
  const longest = `${Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')}.com`
  rejects(longest, 'too_long')
})

test('a 253-octet name is allowed and a 254-octet one is not', () => {
  // 3 labels of 63 + 1 label of 61, plus 3 separators = 253.
  const at253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
  assert.equal(at253.length, 253)
  normalisesTo(at253, at253)
  rejects(`x${at253}`, 'too_long')
})

test('rejects public suffixes but accepts a domain registered under one', () => {
  const suffix = classifyEmailDomain('co.uk', isPublicSuffix)
  assert.equal(suffix.ok === false && suffix.reason, 'public_suffix')
  const pages = classifyEmailDomain('github.io', isPublicSuffix)
  assert.equal(pages.ok === false && pages.reason, 'public_suffix')
  const registered = classifyEmailDomain('example.co.uk', isPublicSuffix)
  assert.equal(registered.ok === true && registered.domain, 'example.co.uk')
})

test('rejects consumer and throwaway mailbox providers', () => {
  for (const domain of [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com',
    'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.net',
    'aol.com', 'yandex.ru', 'mail.ru', 'zoho.com', 'mailinator.com',
    'guerrillamail.com', 'temp-mail.org',
  ]) {
    const decision = classifyEmailDomain(domain, isPublicSuffix)
    assert.equal(decision.ok, false, `${domain} should be refused`)
    assert.equal(decision.ok === false && decision.reason, 'consumer_provider')
  }
})

test('consumer matching is exact — a company domain is not caught by a lookalike', () => {
  for (const domain of ['gmail.com.example.net', 'notgmail.com', 'example.com']) {
    const decision = classifyEmailDomain(domain, isPublicSuffix)
    assert.equal(decision.ok, true, `${domain} should be allowed`)
  }
})

test('a consumer provider is refused however it is written', () => {
  for (const input of ['GMAIL.com', ' gmail.com ', 'gmail.com.']) {
    const decision = classifyEmailDomain(input, isPublicSuffix)
    assert.equal(decision.ok === false && decision.reason, 'consumer_provider')
  }
})

test('subdomains are never implied by a parent domain', () => {
  const parent = classifyEmailDomain('example.com', isPublicSuffix)
  const child = classifyEmailDomain('sub.example.com', isPublicSuffix)
  assert.equal(parent.ok === true && parent.domain, 'example.com')
  assert.equal(child.ok === true && child.domain, 'sub.example.com')
  assert.notEqual(
    parent.ok === true && parent.domain,
    child.ok === true && child.domain,
  )
})

test('domainOfEmail takes the domain after the last @, normalised', () => {
  assert.equal(domainOfEmail('Person@Example.COM'), 'example.com')
  assert.equal(domainOfEmail('odd"name"@example.com'), 'example.com')
  assert.equal(domainOfEmail('a@b@example.com'), 'example.com')
  assert.equal(domainOfEmail('person@bücher.de'), 'xn--bcher-kva.de')
})

test('domainOfEmail refuses addresses with no usable domain', () => {
  assert.equal(domainOfEmail('person'), null)
  assert.equal(domainOfEmail('@example.com'), null)
  assert.equal(domainOfEmail('person@'), null)
  assert.equal(domainOfEmail('person@localhost'), null)
  assert.equal(domainOfEmail('person@127.0.0.1'), null)
  assert.equal(domainOfEmail(''), null)
})

test('every rejection reason has admin-facing copy', () => {
  const reasons: DomainRejection[] = [
    'consumer_provider', 'ip_literal', 'localhost', 'malformed',
    'public_suffix', 'single_label', 'too_long',
  ]
  for (const reason of reasons) {
    assert.equal(typeof DOMAIN_REJECTION_MESSAGES[reason], 'string')
    assert.ok(DOMAIN_REJECTION_MESSAGES[reason].length > 0)
  }
  assert.equal(Object.keys(DOMAIN_REJECTION_MESSAGES).length, reasons.length)
})

test('the consumer list is sorted, deduplicated and normalised', () => {
  const domains = consumerProviderDomains()
  assert.deepEqual([...domains], [...domains].sort())
  assert.equal(new Set(domains).size, domains.length)
  for (const domain of domains) {
    const decision = normaliseDomain(domain)
    assert.equal(decision.ok === true && decision.domain, domain)
  }
})
