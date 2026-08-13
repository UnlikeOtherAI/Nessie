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

test('a starred direct-message entry is removed from its original sidebar location', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')

  assert.match(source, /starredAgentIds\.has\(personalAssistantAgent\.id\)/)
  assert.match(source, /starredChannelIds\.has\(personalAssistantChannelId\)/)
  assert.match(source, /starredAgentIds\.has\(agent\.id\) \|\| starredChannelIds\.has\(agent\.dmChannelId\)/)
  assert.match(source, /starredChannelIds\.has\(group\.dmChannelId\)/)
  assert.match(source, /starredUserIds\.has\(person\.id\)/)
})

test('a group direct-message label is compacted only after its full participant list is measured', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')
  const label = readSource('../src/layouts/admin-shell/GroupDmSidebarLabel.tsx')

  assert.match(sidebar, /<GroupDmSidebarLabel label=\{group\.label\} \/>/)
  assert.match(label, /title=\{label\}/)
  assert.match(label, /new ResizeObserver\(updateWidth\)/)
  assert.match(label, /selectGroupDmSidebarLabel/)
  assert.doesNotMatch(label, /onClick=/)
})

test('the starred Personal Assistant follows its active direct-message route', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')

  assert.match(source, /agent\.agentKind === 'personal_assistant'/)
  assert.match(source, /personalAssistantChannelId === currentChannelId/)
  assert.match(source, /isActivePersonalAssistant \? 'active' : ''/)
})

test('the Direct-messages Personal Assistant reuses the managed agent avatar record', () => {
  const source = readSource('../src/layouts/admin-shell/useAdminShell.ts')

  assert.match(source, /personalAssistantState\?\.agent/)
  assert.match(source, /\?\? agents\.find\(\(agent\) => agent\.agentKind === 'personal_assistant'\)/)
  assert.match(source, /personalAssistantAgent,\n    personalAssistantBootstrapping/)
})

test('the new-message surface excludes the sender and keeps recipients available after selection', () => {
  const source = readSource('../src/pages/ChannelConversationComposePage.tsx')

  assert.match(source, /aria-label="Close new message"/)
  assert.match(source, /setAddressFocused\(true\)/)
  assert.match(source, /document\.activeElement !== addressInputRef\.current/)
  assert.match(source, /useModalA11y\(dialogRef, close, !phoneLayout, addressInputRef\)/)
  assert.match(source, /fixed inset-0 z-\[90\] bg-\[color:var\(--main\)\]/)
  assert.match(source, /placeholder=\{recipients\.length === 0 \? 'Type a name or email address' : ''\}/)
  assert.match(source, /allUsers\.filter\(\(user\) => user\.id !== me\?\.user\.id\)/)
  assert.match(source, /const hasSelectableOptions = options\.length > 0/)
  assert.doesNotMatch(source, /\(you\)/)
  assert.match(source, /admin-compose mt-auto flex-shrink-0/)
  assert.match(source, /StartChannelConversation/)
})

test('the compose route retains the channel workspace and hides mobile navigation chrome', () => {
  const router = readSource('../src/router.tsx')
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const nativeShell = readSource('../../mobile/App.tsx')

  assert.match(router, /path: '\/channels',\n        element: <ChannelsPage \/>/)
  assert.match(router, /path: 'new',\n            element: <ChannelConversationComposePage \/>/)
  assert.match(shell, /mobileLayout && !nativeShell && !isComposeRoute/)
  assert.match(nativeShell, /isFullScreenTaskRoute\(currentPath\)/)
})
