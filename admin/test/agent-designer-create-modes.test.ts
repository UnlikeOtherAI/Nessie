import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('new-agent creation offers prompt-first and manual modes through the shared tab bar', () => {
  const designer = readSource('../src/pages/AgentDesignerPage.tsx')
  const modes = readSource(
    '../src/components/features/agents/designer/AgentCreationModeTabs.tsx',
  )

  assert.match(modes, /label: 'Create'/)
  assert.match(modes, /label: 'Configure'/)
  assert.match(modes, /<TabBar/)
  assert.match(modes, /idPrefix="agent-creation-mode"/)
  assert.match(designer, /const showCreationModes = !isEditMode && !embedded && !readOnly/)
})

test('both creation panels stay mounted over the same designer draft', () => {
  const designer = readSource('../src/pages/AgentDesignerPage.tsx')

  assert.match(designer, /hidden=\{showCreationModes && creationMode !== 'configure'\}/)
  assert.match(designer, /hidden=\{showCreationModes && creationMode !== 'create'\}/)
  assert.equal(
    designer.split('useAgentDesigner(initialState, modelOptions, editingAgent?.id)').length - 1,
    1,
    'the tabs must not fork the form reducer or its persisted draft',
  )
})

test('the prompt-first tab explains that Configure reviews the inferred draft', () => {
  const chat = readSource('../src/components/features/agents/designer/DesignerChat.tsx')

  assert.match(chat, /Tell me what you want the agent to do and I’ll build the draft for you\./)
  assert.match(chat, /fine-tune everything in Configure before creating it/)
})
