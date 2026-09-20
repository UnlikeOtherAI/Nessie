import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const navSource = readFileSync(
  join(process.cwd(), 'src', 'layouts', 'admin-shell', 'admin-nav-items.tsx'),
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
const agentQueriesSource = readFileSync(
  join(process.cwd(), 'src', 'facades', 'agents', 'queries.ts'),
  'utf8',
)
const designerSource = readFileSync(
  join(process.cwd(), 'src', 'pages', 'AgentDesignerPage.tsx'),
  'utf8',
)

test('Team Models is a first-class sidebar page using the shared surface and icon', () => {
  assert.match(navSource, /path: '\/settings\/team\/models'[\s\S]*?icon: modelsIcon/)
  assert.match(navSource, /path: '\/settings\/organization\/models'[\s\S]*?icon: modelsIcon/)
  assert.match(pageSource, /<ModelAvailabilitySettings/)
  assert.match(pageSource, /teamId=\{team\.id\}/)
})

test('team availability calls team-scoped catalogue endpoints', () => {
  assert.match(hooksSource, /\/api\/teams\/\$\{encodeURIComponent\(teamId\)\}\/inference\/model-catalog/)
  assert.match(hooksSource, /inferenceModelKeys\.teamCatalog\(teamId\)/)
})

test('editing an agent asks for that agent team model policy explicitly', () => {
  assert.match(agentQueriesSource, /\/api\/agents\/models\?agentId=/)
  assert.match(designerSource, /useAgentModelOptions\(editingAgent\?\.id\)/)
})
