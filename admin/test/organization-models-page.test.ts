import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(
  join(process.cwd(), 'src', 'components', 'features', 'inference-models', 'ModelAvailabilitySettings.tsx'),
  'utf8',
)

test('deployment model filters are server-side URL state', () => {
  assert.match(source, /searchParams\.get\('model'\)/)
  // Not `provider`: that spelling is Connected accounts' consumed OAuth return.
  assert.match(source, /searchParams\.get\('modelProvider'\)/)
  assert.match(source, /useDeploymentModelCatalog\(true, filters, teamId\)/)
  assert.match(source, /next\.delete\('cursor'\)/)
  assert.doesNotMatch(source, /catalog\.items\.filter/)
})

test('the shared surface uses team-scoped catalogue controls when given a team', () => {
  assert.match(source, /useSetDeploymentModelsEnabled\(teamId\)/)
  assert.match(source, /useSetDeploymentModelEnabled\(teamId\)/)
  // One page in the Organisation group at either scope; the switch names which.
  assert.match(source, /eyebrow="Organisation"/)
  assert.doesNotMatch(source, /Every model this deployment can run, as the model service/)
})

test('each scope carries its own-computers policy, and Test says who may send one', () => {
  assert.match(source, /<LocalInferenceEnablement scope=\{teamId \? 'team' : 'organization'\}/)
  // The policy is an administrator-authored key: shown to that standing only,
  // read through the one hook the team page's Overrides row reads too.
  assert.match(source, /const status = useOrganizationAdministration\(\)/)
  assert.match(source, /if \(status !== 'allowed'\)/)
  assert.doesNotMatch(source, /administration\.status/)
  assert.match(source, /testUnavailableReason/)
})

test('the administration standing is the server’s one answer, local installs included', () => {
  const facade = readFileSync(
    join(process.cwd(), 'src', 'facades', 'organization', 'hooks.ts'),
    'utf8',
  )
  const hook = /export const useOrganizationAdministration[\s\S]*?\n\n/.exec(`${facade}\n\n`)?.[0] ?? ''
  // `/api/organizations/current` answers with the resolver the policy routes
  // use — on an unbound local install, the local owner or admin role — so the
  // client reads that status and never re-derives it from roles, which is how
  // a local admin would come to be refused a setting the API lets them change.
  assert.match(hook, /useCurrentOrganization\(\)\.data\?\.administration\.status/)
  assert.doesNotMatch(hook, /roleIds|isOwner|isAdminRole|providerType/)

  const overrides = readFileSync(
    join(process.cwd(), 'src', 'pages', 'settings', 'team', 'TeamOverridesPage.tsx'),
    'utf8',
  )
  const people = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'PeoplePage.tsx'), 'utf8')
  for (const page of [overrides, people]) {
    assert.match(page, /useOrganizationAdministration\(\)/)
    assert.doesNotMatch(page, /administration\.status/)
  }
  // The row into this policy is greyed without the standing, never a live
  // doorway into the refusal above.
  assert.match(overrides, /ownComputersDoorway\(models, useOrganizationAdministration\(\)\)/)
  assert.match(overrides, /target=\{ownComputers\}/)
})

test('bulk availability acts on the filtered catalogue rather than shown rows', () => {
  assert.match(source, /useSetDeploymentModelsEnabled\(teamId\)/)
  assert.match(source, /setBulkEnabled\.mutate\(\s*\{ \.\.\.filters, enabled \}/)
  assert.match(source, /across the full catalogue/)
  assert.match(source, /not only the rows on this page/)
  assert.doesNotMatch(source, /catalog\.items\.map\([^)]*setEnabled/)
})

test('bulk controls wait for the visible filter to be the applied filter', () => {
  assert.match(source, /const filtersSettled = modelFilter === debouncedModelFilter/)
  assert.match(source, /disabled=\{!filtersSettled \|\| !matchingCount/)
})
