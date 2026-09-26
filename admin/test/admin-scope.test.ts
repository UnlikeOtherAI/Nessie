import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ORGANISATION_SCOPE,
  resolveAdminScope,
  teamScopedPath,
  teamScopeValue,
  type AdminScopeOption,
} from '../src/lib/admin-scope.js'
import {
  connectionScopeOptions,
  keyScopeOptions,
  modelScopeOptions,
  peopleScopeOptions,
  teamScopeOption,
  type ScopeViewer,
} from '../src/pages/admin/scope-entitlements.js'
import { teamInheritanceChips } from '../src/components/features/settings/setting-inheritance.js'
import { connectedMailSettingsPath } from '../src/facades/mail/settings-path.js'
import type { ResolvedSetting } from '../src/facades/settings/hooks.js'

// The Organisation pages' scope switch (docs/plans/2026-09-26-admin-ux-overhaul.md
// §6.8): the scopes a page offers are decided by the API gate each one
// carries, never by the team the session is in; the address always names the
// target of a write; and a team the address names but the page does not offer
// is an error rather than a quiet fall-back.

const DESIGN = { id: '11111111-1111-4111-8111-111111111111', name: 'Design', viewerIsMember: true }
const SALES = { id: '22222222-2222-4222-8222-222222222222', name: 'Sales', viewerIsMember: false }
const TEAMS = [DESIGN, SALES]

const OWNER: ScopeViewer = { isOrganizationAdmin: true, isOwner: true }
const ADMIN: ScopeViewer = { isOrganizationAdmin: true, isOwner: false }
const MEMBER: ScopeViewer = { isOrganizationAdmin: false, isOwner: false }

const usable = (options: readonly AdminScopeOption[]) =>
  options.filter((option) => !option.unavailableReason).map((option) => option.value)

const disabled = (options: readonly AdminScopeOption[]) =>
  options.filter((option) => option.unavailableReason).map((option) => option.value)

test('AI models: the organisation is the owner’s, every team is any owner’s or admin’s', () => {
  assert.deepEqual(usable(modelScopeOptions(OWNER, TEAMS)), [
    ORGANISATION_SCOPE,
    teamScopeValue(DESIGN.id),
    teamScopeValue(SALES.id),
  ])

  // An admin is shown the organisation — disabled, with who holds it — and
  // every team, whether or not they are in it: the team routes answer
  // `requireOrgAdmin` for any team of the organisation.
  const admin = modelScopeOptions(ADMIN, TEAMS)
  assert.deepEqual(disabled(admin), [ORGANISATION_SCOPE])
  assert.match(admin[0]?.unavailableReason ?? '', /organisation owner/)
  assert.deepEqual(usable(admin), [teamScopeValue(DESIGN.id), teamScopeValue(SALES.id)])

  // A member may use none of it, so the page refuses rather than listing.
  assert.deepEqual(usable(modelScopeOptions(MEMBER, TEAMS)), [])
})

test('Keys: every scope above a person’s own is the owner’s', () => {
  assert.equal(usable(keyScopeOptions(OWNER, TEAMS)).length, 3)
  for (const viewer of [ADMIN, MEMBER]) {
    const options = keyScopeOptions(viewer, TEAMS)
    assert.deepEqual(usable(options), [])
    // Listed disabled, so a team page's Keys doorway can say who holds it.
    assert.match(teamScopeOption(options, DESIGN.id)?.unavailableReason ?? '', /organisation owner/)
  }
})

test('Company connections: the organisation and every team are any owner’s or admin’s', () => {
  assert.equal(usable(connectionScopeOptions(OWNER, TEAMS)).length, 3)
  assert.equal(usable(connectionScopeOptions(ADMIN, TEAMS)).length, 3)
  assert.deepEqual(usable(connectionScopeOptions(MEMBER, TEAMS)), [])
})

test('People: the organisation for its administrators, and only the teams the viewer is in', () => {
  const administrator = peopleScopeOptions({ canSeeOrganization: true }, TEAMS)
  assert.deepEqual(usable(administrator), [ORGANISATION_SCOPE, teamScopeValue(DESIGN.id)])

  // Somebody else still sees the organisation — disabled, and why — rather
  // than a switch that silently lacks it; a team they are not in is absent.
  const member = peopleScopeOptions({ canSeeOrganization: false }, TEAMS)
  assert.deepEqual(disabled(member), [ORGANISATION_SCOPE])
  assert.deepEqual(usable(member), [teamScopeValue(DESIGN.id)])
  assert.equal(member.some((option) => option.value === teamScopeValue(SALES.id)), false)
})

test('an address that names no scope opens the organisation, when it is the viewer’s', () => {
  const resolution = resolveAdminScope({ options: modelScopeOptions(OWNER, TEAMS), requested: null })
  assert.equal(resolution.status, 'ready')
  assert.deepEqual(resolution.status === 'ready' ? resolution.scope : null, { kind: 'organisation' })
})

test('when the organisation is not the viewer’s, they land on a team the address will then name', () => {
  const options = modelScopeOptions(ADMIN, TEAMS)
  // The working team, when it is one of the viewer's choices…
  const preferred = resolveAdminScope({ options, preferredTeamId: SALES.id, requested: null })
  assert.equal(preferred.status, 'landing')
  assert.equal(preferred.status === 'landing' ? preferred.option.value : null, teamScopeValue(SALES.id))

  // …otherwise the first team offered. Either way it is a landing, which the
  // switch writes into the address before anything is shown under it.
  const first = resolveAdminScope({ options, preferredTeamId: 'not-a-team', requested: null })
  assert.equal(first.status === 'landing' ? first.option.value : null, teamScopeValue(DESIGN.id))
})

test('a team the address names is shown — and one it cannot be is an error, never a fall-back', () => {
  const options = modelScopeOptions(ADMIN, TEAMS)

  const named = resolveAdminScope({ options, requested: teamScopeValue(SALES.id) })
  assert.equal(named.status, 'ready')
  assert.deepEqual(named.status === 'ready' ? named.scope : null, { kind: 'team', teamId: SALES.id })

  // A team from another organisation, or a mistyped one, is not quietly
  // replaced by the organisation or the first team.
  const unknown = resolveAdminScope({ options, requested: teamScopeValue('33333333-3333-4333-8333-333333333333') })
  assert.equal(unknown.status, 'unknown')
  assert.equal(resolveAdminScope({ options, requested: '' }).status, 'unknown')

  // A scope the viewer could hold with more standing says so.
  const organisation = resolveAdminScope({ options, requested: ORGANISATION_SCOPE })
  assert.equal(organisation.status, 'unavailable')
})

test('nothing is resolved before the teams are known, and nothing usable is a refusal', () => {
  assert.equal(resolveAdminScope({ options: null, requested: null }).status, 'loading')
  assert.equal(resolveAdminScope({ failed: true, options: null, requested: null }).status, 'failed')
  const refused = resolveAdminScope({
    options: keyScopeOptions(ADMIN, TEAMS),
    requested: teamScopeValue(DESIGN.id),
  })
  assert.equal(refused.status, 'refused')
})

test('a team’s doorway into a scoped page names the team in the address', () => {
  assert.equal(
    teamScopedPath('/admin/models', DESIGN.id),
    `/admin/models?scope=team:${DESIGN.id}`,
  )
  assert.equal(
    new URLSearchParams(teamScopedPath('/admin/keys', 'a b').split('?')[1]).get('scope'),
    'team:a b',
  )
})

test('a shared mailbox’s settings open Company connections at its team’s scope', () => {
  const shared = { id: 'mbx-1', scope: 'shared' as const, source: 'mailbox' as const }
  assert.equal(
    connectedMailSettingsPath(shared, DESIGN.id),
    `/admin/connections?scope=team:${DESIGN.id}#connection-mbx-1`,
  )
  assert.equal(connectedMailSettingsPath(shared), '/admin/connections#connection-mbx-1')
  assert.equal(
    connectedMailSettingsPath({ id: 'gm-1', scope: 'personal', source: 'gmail' }, DESIGN.id),
    '/settings/accounts#connection-gm-1',
  )
})

const setting = (overrides: Partial<ResolvedSetting>): ResolvedSetting => ({
  canEdit: true,
  key: 'k',
  lockedAtScope: null,
  lockedHere: false,
  setAtScope: null,
  value: null,
  ...overrides,
})

test('a team’s inheritance reads as chips: who set it, and who locked it', () => {
  assert.deepEqual(teamInheritanceChips(undefined), [])
  assert.deepEqual(teamInheritanceChips(setting({})), [])
  assert.deepEqual(
    teamInheritanceChips(setting({ lockedAtScope: 'organization', setAtScope: 'organization', value: true }))
      .map((chip) => chip.label),
    ['Set by organisation', 'Locked by organisation'],
  )
  assert.deepEqual(
    teamInheritanceChips(setting({ lockedAtScope: 'team', setAtScope: 'team', value: 'x' }))
      .map((chip) => chip.label),
    ['Set by this team', 'Locked by this team'],
  )
  // A lock-only row pins what resolved above without setting anything.
  assert.deepEqual(
    teamInheritanceChips(setting({ lockedAtScope: 'organization' })).map((chip) => chip.label),
    ['Locked by organisation'],
  )
})
