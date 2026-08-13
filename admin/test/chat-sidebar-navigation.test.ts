import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the direct-messages plus opens the recipient-addressed conversation composer', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')

  assert.match(source, /aria-label="Start new chat"/)
  assert.match(source, /onClick=\{onStartNewConversation\}/)
  assert.doesNotMatch(source, /onNavigateSettings/)
  assert.doesNotMatch(source, /Invite people/)
})

test('chat navigation does not duplicate the Agents activity section', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarNav.tsx')

  assert.doesNotMatch(source, /AgentActivityPanel/)
  assert.doesNotMatch(source, /sidebar-nav-agents/)
})

test('the new-message screen excludes the sender and keeps recipients available after selection', () => {
  const source = readSource('../src/pages/ChannelConversationComposePage.tsx')

  assert.match(source, /AdminPageHeader title="New message"/)
  assert.match(source, /placeholder=\{recipients\.length === 0 \? 'Type a name or email address' : ''\}/)
  assert.match(source, /allUsers\.filter\(\(user\) => user\.id !== me\?\.user\.id\)/)
  assert.match(source, /const hasSelectableOptions = options\.length > 0/)
  assert.doesNotMatch(source, /\(you\)/)
  assert.match(source, /admin-compose mt-auto flex-shrink-0/)
  assert.match(source, /StartChannelConversation/)
})
