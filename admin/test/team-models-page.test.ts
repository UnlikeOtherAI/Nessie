import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const settingsSource = readFileSync(
  join(process.cwd(), 'src', 'pages', 'settings', 'TeamSettingsPage.tsx'),
  'utf8',
)
const pageSource = readFileSync(
  join(process.cwd(), 'src', 'pages', 'settings', 'team', 'TeamModelsPage.tsx'),
  'utf8',
)
const hooksSource = readFileSync(
  join(process.cwd(), 'src', 'facades', 'inference-models', 'hooks.ts'),
  'utf8',
)

test('team settings exposes Models through the shared availability surface', () => {
  assert.match(settingsSource, /\{ label: 'Models', value: 'models' \}/)
  assert.match(settingsSource, /models: TeamModelsPage/)
  assert.match(pageSource, /<ModelAvailabilitySettings tabs=\{tabs\} teamId=\{team\.id\} \/>/)
})

test('team availability calls team-scoped catalogue endpoints', () => {
  assert.match(hooksSource, /\/api\/teams\/\$\{encodeURIComponent\(teamId\)\}\/inference\/model-catalog/)
  assert.match(hooksSource, /inferenceModelKeys\.teamCatalog\(teamId\)/)
})
