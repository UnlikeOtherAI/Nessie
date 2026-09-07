import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('designer groups independent configuration into the shared tab bar', () => {
  const form = readSource('../src/components/features/agents/designer/AgentDesignerForm.tsx')

  assert.match(form, /<TabBar<AgentDesignerSection>/)
  assert.match(form, /ariaLabel="Agent configuration sections"/)
  assert.match(form, /idPrefix="agent-designer-section"/)
  assert.match(form, /onChange=\{onSectionChange\}/)
  assert.match(form, /label: 'Basics'/)
  assert.match(form, /label: 'Behavior'/)
  assert.match(form, /label: 'To-dos'/)
  assert.match(form, /label: 'Tools'/)
})

test('section switches retain one designer draft and keep unavailable tools out of edit mode', () => {
  const form = readSource('../src/components/features/agents/designer/AgentDesignerForm.tsx')
  const page = readSource('../src/pages/AgentDesignerPage.tsx')

  for (const section of ['basics', 'behavior', 'todos', 'tools']) {
    assert.match(form, new RegExp(`hidden=\\{section !== '${section}'\\}`))
  }
  assert.match(form, /items=\{showTools \? DESIGNER_SECTIONS : DESIGNER_SECTIONS\.slice\(0, -1\)\}/)
  assert.doesNotMatch(form, /useState<AgentFormState>/)
  assert.match(page, /useTabParam\(\n    'designerSection'/)
  assert.equal(
    page.split('useAgentDesigner(initialState, modelOptions, editingAgent?.id)').length - 1,
    1,
    'all Configure sections must write the existing page-level draft reducer',
  )
})
