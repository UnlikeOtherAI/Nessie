import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent details put the avatar editor at the agent detail surface for owners only', () => {
  const drawer = readSource('../src/components/features/agents/AgentDetailDrawer.tsx')

  assert.match(drawer, /const isOwner = me\?\.user\.roleIds\.includes\('owner'\) \?\? false/)
  assert.match(drawer, /<AgentAvatarQuickEdit agent=\{agent\} canEdit=\{isOwner\} \/>/)
})

test('the avatar pencil opens a modal with a prompt, AI generation, upload, remove, and close', () => {
  const source = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')

  // Pencil on the avatar itself opens the modal.
  assert.match(source, /aria-label=\{`Edit \$\{agent\.name\} avatar`\}/)
  assert.match(source, /<PencilIcon \/>/)
  // Generate with a free-text prompt.
  assert.match(source, /Generate with AI/)
  assert.match(source, /placeholder="Describe the look you want \(optional\)"/)
  assert.match(source, /avatarChanges\.generate\(prompt\)/)
  // Upload path still routes through the cropper.
  assert.match(source, /Upload/)
  assert.match(source, /<CircleImageCropper/)
  // A single close control (top-right) and a remove control (only with a custom image).
  assert.match(source, /aria-label="Close"/)
  assert.match(source, /Remove image/)
  assert.match(source, /hasCustom && !generated/)
})

test('the designer edit form and the detail header share the one avatar editor + mutation flow', () => {
  const designer = readSource('../src/pages/AgentDesignerPage.tsx')
  const quickEdit = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')

  // The designer's edit-mode avatar is the same pencil-modal component, not a
  // second panel implementation, fed the live draft context.
  assert.match(designer, /<AgentAvatarQuickEdit/)
  assert.match(designer, /avatarContext=\{\{/)
  // Both doorways go through the shared mutation hook.
  assert.match(quickEdit, /useAgentAvatarChanges\(\n {4}agent\.id,/)
})

test('agent avatar generation has an announced spinning progress indicator', () => {
  const quickEdit = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')
  const indicator = readSource('../src/components/features/agents/AgentAvatarGenerationIndicator.tsx')

  assert.match(quickEdit, /avatarChanges\.isGenerating \? \(\s*<AgentAvatarGenerationIndicator/)
  assert.match(indicator, /animate-spin/)
  assert.match(indicator, /role="status"/)
})
