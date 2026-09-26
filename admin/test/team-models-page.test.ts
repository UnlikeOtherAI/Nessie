import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const read = (...path: string[]) => readFileSync(join(process.cwd(), 'src', ...path), 'utf8')

const navSource = read('layouts', 'admin-shell', 'admin-nav-items.tsx')
const modelsPageSource = read('pages', 'admin', 'ModelsPage.tsx')
const hooksSource = read('facades', 'inference-models', 'hooks.ts')
const agentQueriesSource = read('facades', 'agents', 'queries.ts')
const designerSource = read('pages', 'AgentDesignerPage.tsx')

test('AI models is one Admin page whose scope switch reaches every team', () => {
  assert.match(navSource, /path: '\/admin\/models', label: 'AI models'[\s\S]*?icon: modelsIcon/)
  // The one catalogue surface, at the scope the address names.
  assert.match(modelsPageSource, /useAdminScope\(/)
  assert.match(modelsPageSource, /<ModelAvailabilitySettings/)
  assert.match(modelsPageSource, /teamId: scope\.teamId/)
})

test('team availability calls team-scoped catalogue endpoints', () => {
  assert.match(hooksSource, /\/api\/teams\/\$\{encodeURIComponent\(teamId\)\}\/inference\/model-catalog/)
  assert.match(hooksSource, /inferenceModelKeys\.teamCatalog\(teamId\)/)
  // The page's own `?scope=` names the team; a pagination scope written into
  // the same unprefixed param would overwrite it on the first Next.
  assert.doesNotMatch(hooksSource, /scope: teamId/)
})

test('editing an agent asks for that agent team model policy explicitly', () => {
  assert.match(agentQueriesSource, /\/api\/agents\/models\?agentId=/)
  assert.match(designerSource, /useAgentModelOptions\(editingAgent\?\.id\)/)
})
