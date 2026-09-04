import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const panel = readFileSync(new URL('../src/pages/settings/AutomaticMembershipRulesPanel.tsx', import.meta.url), 'utf8')
const facade = readFileSync(new URL('../src/facades/users/automatic-membership.ts', import.meta.url), 'utf8')
const members = readFileSync(new URL('../src/pages/settings/MembersRosterPanel.tsx', import.meta.url), 'utf8')

test('automatic membership has one shared panel behind both member tab scopes', () => {
  assert.match(members, /AutomaticMembershipRulesPanel scope=\{scope\}/)
  assert.match(panel, /One parameterised panel, rendered in both organization and team Members tabs/)
  assert.match(members, /label: 'Automatic logins'/)
})

test('automatic membership controls are capability-gated and confirmation-based', () => {
  assert.match(panel, /permissions\?\.manageRules === true/)
  assert.match(panel, /permissions\?\.manageClaim === true/)
  assert.match(panel, /<ConfirmDialog/)
  assert.doesNotMatch(panel, /window\.confirm/)
  assert.match(panel, /Existing memberships are preserved/)
})

test('automatic membership communicates identity and privacy boundaries', () => {
  assert.match(panel, /A verified domain never authenticates a person/)
  assert.match(panel, /UOA must assert a currently verified email at sign-in/)
  assert.match(panel, /Progress is aggregate only\. Matching people stay in UOA/)
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
