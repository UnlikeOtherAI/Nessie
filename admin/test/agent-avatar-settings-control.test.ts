import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('agent details put the avatar editor at the agent detail surface for its editors only', () => {
  const drawer = readSource('../src/components/features/agents/AgentDetailDrawer.tsx')
  const identityBlock = readSource('../src/components/features/agents/AgentIdentityBlock.tsx')

  // Who may edit is the agent's ownership state, not the organization owner
  // role, and that derivation lives in one place beside the server's.
  assert.match(drawer, /const canEdit = useCanEditAgent\(agent\)/)
  // The avatar editor lives once, in the shared identity block both the
  // detail page header and this drawer compose.
  assert.match(drawer, /<AgentIdentityBlock agent=\{agent\} canEditAvatar=\{canEdit\} \/>/)
  assert.match(identityBlock, /<AgentAvatarQuickEdit agent=\{agent\} canEdit=\{canEditAvatar\} size=\{avatarSize\} \/>/)
})

test('the avatar pencil opens a modal, built on the shared Dialog shell, with a prompt, AI generation, upload, and a confirmed remove', () => {
  const source = readSource('../src/components/features/agents/AgentAvatarQuickEdit.tsx')

  // Pencil on the avatar itself opens the modal.
  assert.match(source, /aria-label=\{`Edit \$\{agent\.name\} avatar`\}/)
  assert.match(source, /<PencilIcon \/>/)
  // Generate with a free-text prompt.
  assert.match(source, /Generate with AI/)
  assert.match(source, /placeholder="Add avatar details to the agent instructions \(optional\)"/)
  assert.match(source, /avatarChanges\.generate\(prompt\)/)
  // Upload path still routes through the cropper.
  assert.match(source, /Upload/)
  assert.match(source, /<CircleImageCropper/)
  // The modal shell is the shared Dialog — its own close control and focus
  // trap come for free, rather than a second hand-rolled scrim.
  assert.match(source, /<Dialog onClose=\{close\} open=\{open\} title=\{`\$\{agent\.name\} avatar`\}>/)
  // Removing the custom avatar is confirmed, not a one-click destructive action.
  assert.match(source, /onClick=\{\(\) => setRemoveConfirmOpen\(true\)\}/)
  assert.match(source, /<ConfirmDialog/)
  assert.match(source, /destructive/)
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

  assert.match(quickEdit, /avatarChanges\.isGenerating \? <AgentAvatarGenerationIndicator/)
  assert.match(indicator, /animate-spin/)
  assert.match(indicator, /role="status"/)
})
