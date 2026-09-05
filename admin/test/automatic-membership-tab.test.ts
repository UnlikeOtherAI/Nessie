/**
 * Source-level guarantees for the Automatic logins tab.
 *
 * `MembersRosterPanel` is the one component behind both Organization → Members
 * and Team → Members, so the tab is added there rather than forked. These cases
 * pin the four wiring details that adding a fourth tab to an existing strip is
 * easy to get wrong, and which would each be a live defect:
 *
 *  - the roster query must not fire on the new tab,
 *  - "Send invitation" must not render on it,
 *  - a roster error must not blank the rules panel,
 *  - the pagination footer must not sit under it.
 *
 * They are read from source rather than rendered because the panel's data comes
 * from three facades behind a provider tree; the assertions here are about
 * wiring, and the rendered behaviour is covered by the Playwright pass.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    .replaceAll('\r\n', '\n')

const rosterPanel = read('../src/pages/settings/MembersRosterPanel.tsx')
const rulesPanel = read('../src/components/features/settings/AutomaticMembershipRulesPanel.tsx')
const invitationDialog = read('../src/pages/settings/MemberInvitationDialog.tsx')
const domainRow = read('../src/components/features/settings/AutomaticMembershipDomainRow.tsx')
const reconcileStatus = read(
  '../src/components/features/settings/AutomaticMembershipReconcileStatus.tsx',
)

test('the tab lives in the one shared roster panel, not a second component', () => {
  assert.match(rosterPanel, /'automatic'/)
  assert.match(rosterPanel, /label: 'Automatic logins', value: 'automatic'/)
  assert.match(rosterPanel, /<AutomaticMembershipRulesPanel scope=\{scope\} \/>/)
})

test('the rules panel is parameterised by scope, serving both surfaces', () => {
  assert.match(rulesPanel, /scope,\s*\}: \{\s*scope: AutomaticMembershipScope\s*\}/)
  assert.match(rulesPanel, /useAutomaticMembership\(scope\)/)
})

test('the roster query does not fire on the Automatic logins tab', () => {
  assert.match(
    rosterPanel,
    /const isRosterTab = tab === 'active' \|\| tab === 'deactivated'/,
    'the roster query must be enabled only for the two roster tabs',
  )
  assert.match(rosterPanel, /useMemberRoster\(\s*scope,[^)]*isRosterTab,\s*\)/s)
})

test('Send invitation does not render on the Automatic logins tab', () => {
  assert.match(
    rosterPanel,
    /const canInvite = permissions\?\.addMember === true && tab !== 'automatic'/,
  )
})

test('a roster error cannot blank the rules panel', () => {
  // The rules panel is rendered before, and outside, the roster's QueryState.
  const panelIndex = rosterPanel.indexOf('<AutomaticMembershipRulesPanel')
  const queryStateIndex = rosterPanel.indexOf('errorLabel="Members could not be loaded."')
  assert.ok(panelIndex > 0 && queryStateIndex > 0)
  assert.ok(
    panelIndex < queryStateIndex,
    'the automatic branch must short-circuit before the roster QueryState',
  )
})

test('the pagination footer never renders under the rules panel', () => {
  assert.match(rosterPanel, /\{current \? \(\s*<PaginationFooter/)
  assert.match(rosterPanel, /const current = tab === 'automatic' \? null/)
})

test('the rules panel renders Sections, never a nested SettingsPanel', () => {
  assert.doesNotMatch(
    rulesPanel,
    /<SettingsPanel/,
    'a bordered box never sits inside a bordered box (docs/standards/design-system.md)',
  )
  assert.match(rulesPanel, /<Section/)
})

test('the copy never suggests a domain authenticates anybody', () => {
  const forbidden = [/auto-?login/i, /domain login/i, /trusted domain/i, /signs? you in/i]
  for (const pattern of forbidden) {
    assert.doesNotMatch(rulesPanel, pattern)
    assert.doesNotMatch(domainRow, pattern)
  }
  assert.match(rulesPanel, /Sign-in always verifies who someone is/)
  assert.match(rulesPanel, /a domain never\s*\+?\s*'?signs anyone in/s)
})

test('the tab label is the agreed wording', () => {
  assert.match(rosterPanel, /Automatic logins/)
  assert.match(rulesPanel, /Automatic team access after sign-in/)
})

test('narrowing and pausing say plainly that nobody is removed', () => {
  assert.match(rulesPanel, /Nobody is removed|nobody has been removed/)
  assert.match(domainRow, /nobody has been removed/)
  assert.match(rulesPanel, /keep their access/)
})

test('the invitation dialog carries the in-context doorway', () => {
  assert.match(invitationDialog, /Set up automatic team access/)
  assert.match(invitationDialog, /updated\.set\('membersTab', 'automatic'\)/)
})

test('reconciliation shows counters, never a list of matching people', () => {
  assert.match(reconcileStatus, /role="status"/)
  assert.match(reconcileStatus, /aria-live="polite"/)
  assert.match(reconcileStatus, /checked · .* matched · .* added/)
  assert.doesNotMatch(reconcileStatus, /\.email|displayName|uoaSub/)
})

test('a rule that lost its authorization offers the remedy, not a bare error', () => {
  assert.match(domainRow, /needs_reauthorization/)
  assert.match(domainRow, /Re-authorize \$\{rule\.teamName\}/)
  assert.match(domainRow, /Nobody has lost access/)
})

test('status is conveyed by text, not colour alone', () => {
  assert.match(domainRow, /STATUS_LABEL: Record<AutomaticMembershipDomainStatus, string>/)
  assert.match(reconcileStatus, /STATUS_LABEL: Record</)
})

test('the team picker is a labelled fieldset of checkboxes', () => {
  const picker = read('../src/components/features/settings/AutomaticMembershipTeamPicker.tsx')
  assert.match(picker, /<fieldset/)
  assert.match(picker, /<legend/)
  assert.match(picker, /<Checkbox/)
  assert.doesNotMatch(picker, /<Switch/, 'a checkbox picks several of many; a switch is one boolean')
})

test('the DNS instructions are a definition list with an announced copy control', () => {
  const dns = read('../src/components/features/settings/AutomaticMembershipDnsPanel.tsx')
  assert.match(dns, /<dl/)
  assert.match(dns, /<dt/)
  assert.match(dns, /<dd/)
  assert.match(dns, /role="status"|Copied/)
})
