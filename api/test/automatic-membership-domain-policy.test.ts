import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAutomaticMembershipDomainAllowed,
  DomainPolicyError,
  normalizeAutomaticMembershipDomain,
} from '../src/services/automatic-membership-domain-policy.js'

test('normalizes exact IDNA domains without accepting an email address', () => {
  assert.equal(normalizeAutomaticMembershipDomain('Example.COM.'), 'example.com')
  assert.throws(() => normalizeAutomaticMembershipDomain('owner@example.com'), DomainPolicyError)
  assert.throws(() => normalizeAutomaticMembershipDomain('127.0.0.1'), DomainPolicyError)
  assert.throws(() => normalizeAutomaticMembershipDomain('localhost'), DomainPolicyError)
})

test('blocks public, consumer, and disposable domains', () => {
  for (const domain of ['com', 'co.uk', 'company.kawasaki.jp', 'gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'mailinator.com']) {
    assert.throws(() => assertAutomaticMembershipDomainAllowed(domain), DomainPolicyError)
  }
  assert.equal(assertAutomaticMembershipDomainAllowed('engineering.example.com'), 'engineering.example.com')
})

test('uses a bundled maintained PSL and permits ordinary business domains', () => {
  assert.equal(assertAutomaticMembershipDomainAllowed('mail.google.com'), 'mail.google.com')
  assert.equal(assertAutomaticMembershipDomainAllowed('city.kawasaki.jp'), 'city.kawasaki.jp')
})
