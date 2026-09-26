import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('New agent offers prompt-first and manual modes through the shared tab bar', () => {
  const flow = readSource('../src/components/features/agents/page/NewAgentFlow.tsx')
  const modes = readSource(
    '../src/components/features/agents/designer/AgentCreationModeTabs.tsx',
  )

  assert.match(modes, /label: 'Create'/)
  assert.match(modes, /label: 'Configure'/)
  assert.match(modes, /<TabBar/)
  assert.match(modes, /idPrefix="agent-creation-mode"/)
  // The mode is the flow's one strip, in the URL.
  assert.match(flow, /useTabParam\('mode', CREATION_MODE_VALUES, 'create'\)/)
  assert.match(flow, /tabs=\{<AgentCreationModeTabs onChange=\{selectMode\} value=\{mode\} \/>\}/)
})

test('both creation panels stay mounted over the same draft', () => {
  const flow = readSource('../src/components/features/agents/page/NewAgentFlow.tsx')

  assert.match(flow, /hidden=\{mode !== 'configure'\}/)
  assert.match(flow, /hidden=\{mode !== 'create'\}/)
  assert.equal(
    flow.match(/useAgentConfigForm\(/g)?.length,
    1,
    'the modes must not fork the form reducer or its persisted draft',
  )
})

test('Configure is the agent page’s own fields, so a new agent opens on the tabs it filled', () => {
  const flow = readSource('../src/components/features/agents/page/NewAgentFlow.tsx')
  const page = readSource('../src/pages/AgentDetailPage.tsx')

  for (const field of ['AgentNameRoleFields', 'AgentVisibilityField', 'AgentModelFields', 'AgentInstructionsField', 'AgentMannerFields', 'NewAgentTools']) {
    assert.match(flow, new RegExp(`<${field} form=\\{form\\}`), `${field} is the page's own field`)
  }
  // Create replaces the flow with the new agent's page, so Back from there
  // lands wherever New agent was pressed.
  assert.match(
    page,
    /onCreated=\{\(agent\) => void navigate\(`\$\{AGENTS_PATH\}\/\$\{agent\.id\}`, \{ replace: true \}\)\}/,
  )
})

test('the prompt-first tab explains that Configure reviews the inferred draft', () => {
  const chat = readSource('../src/components/features/agents/designer/DesignerChat.tsx')

  assert.match(chat, /Tell me what you want the agent to do and I’ll build the draft for you\./)
  assert.match(chat, /fine-tune everything in Configure before creating it/)
})
