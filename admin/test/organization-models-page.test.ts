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
  // The policy is an administrator-authored key: shown to that standing only.
  assert.match(source, /administration\.status/)
  assert.match(source, /testUnavailableReason/)
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
