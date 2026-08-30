import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent detail keeps one full-height Design Assistant drawer beside every tab', () => {
  const tabs = readSource('../src/components/features/agents/AgentDetailTabs.tsx')
  const page = readSource('../src/pages/AgentDetailPage.tsx')
  const drawer = readSource('../src/components/features/agents/designer/DesignerAssistantDrawer.tsx')

  assert.match(tabs, /pageContextForTab/)
  assert.match(tabs, /title: 'Tools'/)
  assert.match(page, /<DesignerAssistantDrawer \/>/)
  assert.match(drawer, /aria-label="Design Assistant"/)
  assert.match(drawer, /Open Design Assistant/)
  assert.match(drawer, /transition-\[width,height,opacity\]/)
})

test('assistant-driven controls reveal the real UI before changing it', () => {
  const reveal = readSource('../src/components/features/agents/designer/reveal-control.ts')
  const tools = readSource('../src/components/features/agents/AgentAvailableTools.tsx')

  assert.match(reveal, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(reveal, /designer-control-highlight/)
  assert.match(tools, /revealDesignerControl\(`agent-tool-\$\{toolId\}`\)/)
  assert.match(tools, /setToolState/)
})

test('chat input carries the current page and refuses hidden-form mutations', () => {
  const chat = readSource('../src/facades/designer/hooks.ts')
  const designer = readSource('../src/pages/AgentDesignerPage.tsx')

  assert.match(chat, /pageContext: options\.pageContext/)
  assert.match(designer, /hidden form must never change/)
  assert.match(designer, /assistantPanel\.actionHandler/)
})
