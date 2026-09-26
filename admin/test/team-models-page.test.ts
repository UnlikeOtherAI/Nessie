import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const navSource = readFileSync(
  join(process.cwd(), 'src', 'layouts', 'admin-shell', 'admin-nav-items.tsx'),
  'utf8',
)
const teamPageSource = readFileSync(
  join(process.cwd(), 'src', 'pages', 'admin', 'TeamPage.tsx'),
  'utf8',
)
const modelsPageSource = readFileSync(
  join(process.cwd(), 'src', 'pages', 'admin', 'ModelsPage.tsx'),
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

test('AI models is an Admin page, and a team narrows the same surface from its own page', () => {
  assert.match(navSource, /path: '\/admin\/models', label: 'AI models'[\s\S]*?icon: modelsIcon/)
  assert.match(modelsPageSource, /<ModelAvailabilitySettings \/>/)
  // The team's tab is the one shared surface, scoped by the team the address
  // names rather than the one the session is working in.
  assert.match(teamPageSource, /models: 'AI models'/)
  assert.match(teamPageSource, /<ModelAvailabilitySettings host=\{host\} teamId=\{team\.id\} \/>/)
})

test('team availability calls team-scoped catalogue endpoints', () => {
  assert.match(hooksSource, /\/api\/teams\/\$\{encodeURIComponent\(teamId\)\}\/inference\/model-catalog/)
  assert.match(hooksSource, /inferenceModelKeys\.teamCatalog\(teamId\)/)
})

test('editing an agent asks for that agent team model policy explicitly', () => {
  assert.match(agentQueriesSource, /\/api\/agents\/models\?agentId=/)
  assert.match(designerSource, /useAgentModelOptions\(editingAgent\?\.id\)/)
})
