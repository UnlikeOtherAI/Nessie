import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AutomaticMembershipBackfillSummary,
  AutomaticMembershipTeamMapping,
} from '../src/pages/settings/AutomaticMembershipRuleDetails.js'
import type { AutomaticMembershipRuleView } from '../src/facades/users/automatic-membership.js'

// Node's tsx loader uses the classic JSX transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const panel = readFileSync(new URL('../src/pages/settings/AutomaticMembershipRulesPanel.tsx', import.meta.url), 'utf8')
const details = readFileSync(new URL('../src/pages/settings/AutomaticMembershipRuleDetails.tsx', import.meta.url), 'utf8')
const facade = readFileSync(new URL('../src/facades/users/automatic-membership.ts', import.meta.url), 'utf8')
const members = readFileSync(new URL('../src/pages/settings/MembersRosterPanel.tsx', import.meta.url), 'utf8')

test('automatic membership has one shared panel behind both member tab scopes', () => {
  assert.match(members, /AutomaticMembershipRulesPanel scope=\{scope\}/)
  assert.match(panel, /One parameterised panel, rendered in both organization and team Members tabs/)
  assert.match(members, /label: 'Automatic logins'/)
})

test('automatic membership controls are capability-gated and confirmation-based', () => {
  assert.match(panel, /permissions\?\.manageRules === true/)
  assert.match(panel, /rule\.capabilities\.verify/)
  assert.match(panel, /rule\.capabilities\.rotate/)
  assert.match(panel, /rule\.capabilities\.activate/)
  assert.match(panel, /<ConfirmDialog/)
  assert.doesNotMatch(panel, /window\.confirm/)
  assert.match(panel, /Existing memberships are preserved/)
})

test('automatic membership communicates identity and privacy boundaries', () => {
  assert.match(panel, /A verified domain never authenticates a person/)
  assert.match(panel, /UOA must assert a currently verified email at sign-in/)
  assert.match(details, /Progress is aggregate only\. Matching people stay in UOA/)
  assert.match(panel, /DNS ownership proof/)
})

test('automatic membership facade covers mapping, lifecycle, release, and aggregate updates', () => {
  assert.match(facade, /api\.patch\(`\$\{path\(scope\)\}\/\$\{input\.ruleId\}`/)
  assert.match(facade, /\/release/)
  assert.match(facade, /targetTeamIds/)
  assert.match(facade, /failedCount/)
  assert.match(facade, /auditEvents/)
  assert.match(facade, /matching identities remain exclusively in UOA/)
})

const activeRule = {
  auditEvents: [],
  backfill: {
    failedCount: 1,
    grantedCount: 2,
    nextRetryAt: null,
    processedCount: 3,
    status: 'running',
    updatedAt: '2026-09-04T12:00:00.000Z',
  },
  capabilities: {
    activate: false, edit: true, release: false, revoke: true,
    rotate: true, suspend: true, verify: true,
  },
  claimId: '11111111-1111-1111-1111-111111111111',
  claimState: 'verified',
  dns: null,
  domain: 'example.test',
  generation: 1,
  id: '22222222-2222-2222-2222-222222222222',
  lastDnsCheckAt: null,
  notificationEmail: null,
  scope: 'team',
  state: 'active',
  suspensionReason: null,
  targetTeamIds: ['33333333-3333-3333-3333-333333333333'],
  targetTeams: [],
  verificationExpiresAt: '2026-09-18T12:00:00.000Z',
  verifiedAt: '2026-09-04T12:00:00.000Z',
} as AutomaticMembershipRuleView

test('automatic membership renders aggregate-only reconciliation without identity disclosure', () => {
  const html = renderToStaticMarkup(createElement(AutomaticMembershipBackfillSummary, { rule: activeRule }))

  assert.match(html, /Reconciliation/)
  assert.match(html, /3 processed · 2 granted · 1 failed/)
  assert.match(html, /Progress is aggregate only/)
  assert.doesNotMatch(html, /alice@example\.test/i)
})

test('organization team mapping renders native labelled checkboxes', () => {
  const teams = {
    data: { teams: [{ id: '33333333-3333-3333-3333-333333333333', name: 'Design' }] },
    isError: false,
    isLoading: false,
  } as never
  const html = renderToStaticMarkup(createElement(AutomaticMembershipTeamMapping, {
    selected: ['33333333-3333-3333-3333-333333333333'],
    setSelected: () => undefined,
    teams,
  }))

  assert.match(html, /<fieldset/)
  assert.match(html, /Teams to grant after sign-in/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /checked=""/)
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Design<\/label>/)
})
