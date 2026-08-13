import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent details put the avatar editor at the first agent surface for owners only', () => {
  const column = readSource('../src/components/features/agents/AgentDetailColumn.tsx')
  const drawer = readSource('../src/components/features/agents/AgentDetailDrawer.tsx')

  for (const source of [column, drawer]) {
    assert.match(source, /const isOwner = me\?\.user\.roleIds\.includes\('owner'\) \?\? false/)
    assert.match(source, /<AgentAvatarQuickEdit agent=\{agent\} canEdit=\{isOwner\} \/>/)
  }
})

test('the avatar pencil offers AI generation and a dashed file drop zone before crop/save', () => {
  const source = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')

  assert.match(source, /aria-label=\{`Edit \$\{agent\.name\} avatar`\}/)
  assert.match(source, /Generate with AI/)
  assert.match(source, /border-2 border-dashed/)
  assert.match(source, /onDrop=\{handleDrop\}/)
  assert.match(source, /fileInputRef\.current\?\.click\(\)/)
  assert.match(source, /<CircleImageCropper/)
  assert.match(source, /Replace this agent’s avatar\?/)
})

test('full designer and quick settings avatar edits share the same mutation flow', () => {
  const panel = readSource('../src/components/features/agents/AgentAvatarPanel.tsx')
  const quickEdit = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')

  assert.match(panel, /useAgentAvatarChanges\(agent\.id, avatarContext\)/)
  assert.match(quickEdit, /useAgentAvatarChanges\(agent\.id, \{/)
})
