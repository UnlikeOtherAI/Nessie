import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAutomaticMembershipDomainAllowed,
  DomainPolicyError,
  normalizeAutomaticMembershipDomain,
} from '../src/services/automatic-membership-domain-policy.js'

process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL = 'com,net,org,co.uk'
process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL_VERSION = 'test-complete-artifact'

test('normalizes exact IDNA domains without accepting an email address', () => {
  assert.equal(normalizeAutomaticMembershipDomain('Example.COM.'), 'example.com')
  assert.throws(() => normalizeAutomaticMembershipDomain('owner@example.com'), DomainPolicyError)
  assert.throws(() => normalizeAutomaticMembershipDomain('127.0.0.1'), DomainPolicyError)
  assert.throws(() => normalizeAutomaticMembershipDomain('localhost'), DomainPolicyError)
})

test('blocks public, consumer, and disposable domains', () => {
  for (const domain of ['com', 'gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'mailinator.com']) {
    assert.throws(() => assertAutomaticMembershipDomainAllowed(domain), DomainPolicyError)
  }
  assert.equal(assertAutomaticMembershipDomainAllowed('engineering.example.com'), 'engineering.example.com')
})

test('fails closed when the maintained public-suffix artifact is absent', () => {
  const psl = process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL
  delete process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL
  assert.throws(() => assertAutomaticMembershipDomainAllowed('company.example.com'), DomainPolicyError)
  process.env.NESSIE_AUTOMATIC_MEMBERSHIP_PSL = psl
})
