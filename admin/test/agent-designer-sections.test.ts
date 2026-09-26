import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AGENT_PAGE_TABS,
  ASSISTANT_TOOL_TABS,
  agentPageTabs,
  isAssistantToolToggle,
} from '../src/components/features/agents/page/agent-page-tabs.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

test('the agent page is six tabs in one strip, and a built-in agent gets the four that work', () => {
  assert.deepEqual([...AGENT_PAGE_TABS], ['about', 'instructions', 'access', 'schedule', 'activity', 'settings'])
  // Status, activity, schedules and documents 404 for a built-in agent, so
  // its page never mounts a tab that could only report a failure.
  assert.deepEqual([...agentPageTabs({ systemManaged: true })], ['about', 'instructions', 'access', 'settings'])
  assert.deepEqual([...agentPageTabs({ systemManaged: false })], [...AGENT_PAGE_TABS])

  const page = readSource('../src/components/features/agents/page/AgentPage.tsx')
  assert.match(page, /useTabParam\('tab', tabs, 'about'\)/)
  assert.match(page, /<TabBar\n\s+ariaLabel="Agent sections"/)
})

test('Instructions and Settings are one form with one reducer and one save', () => {
  const page = readSource('../src/components/features/agents/page/AgentPage.tsx')
  const form = readSource('../src/components/features/agents/page/useAgentConfigForm.ts')
  const instructions = readSource('../src/components/features/agents/page/AgentInstructionsTab.tsx')
  const settings = readSource('../src/components/features/agents/page/AgentSettingsTab.tsx')

  assert.equal(page.match(/useAgentConfigForm\(/g)?.length, 1, 'the page owns one form for every tab')
  assert.equal(form.match(/useAgentDesigner\(/g)?.length, 1, 'the form is the designer reducer and its draft')
  // Each tab renders fields of the page's form, never state of its own.
  assert.match(instructions, /<AgentInstructionsField form=\{form\}/)
  assert.match(instructions, /<AgentMannerFields form=\{form\}/)
  assert.match(settings, /<AgentNameRoleFields form=\{form\}/)
  assert.match(settings, /<AgentModelFields agentId=\{agent\.id\} form=\{form\}/)
  assert.doesNotMatch(instructions + settings, /useState<AgentFormState>|useAgentDesigner\(/)
  // One save bar, on the two tabs that hold the form, for someone who manages it.
  assert.match(page, /manages && formTab \? <AgentSaveBar/)
})

test('an edit never re-sends a tool policy the Access tab owns', () => {
  const form = readSource('../src/components/features/agents/page/useAgentConfigForm.ts')
  const updateCall = form.slice(form.indexOf('updateAgent.mutateAsync('), form.indexOf('markSaved(state)'))
  assert.doesNotMatch(updateCall, /toolPolicy/)
  // A new agent's tools are part of Create.
  assert.match(form, /toolPolicy: Object\.keys\(toolPolicy\)\.length > 0 \? toolPolicy : undefined/)
})

test('every assistant change lands on the tab that shows its control', () => {
  assert.equal(ASSISTANT_TOOL_TABS.set_name, 'settings')
  assert.equal(ASSISTANT_TOOL_TABS.set_role, 'settings')
  assert.equal(ASSISTANT_TOOL_TABS.set_model, 'settings')
  assert.equal(ASSISTANT_TOOL_TABS.set_system_prompt, 'instructions')
  for (const name of ['toggle_tool', 'batch_toggle_tools', 'set_tool_selection']) {
    assert.equal(ASSISTANT_TOOL_TABS[name], 'access')
    assert.equal(isAssistantToolToggle(name), true)
  }
  assert.equal(isAssistantToolToggle('set_name'), false)
})
