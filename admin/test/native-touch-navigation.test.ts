import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('every native touch sidebar uses Slack-scale density while desktop remains compact', () => {
  const sidebars = [
    readSource('../src/layouts/admin-shell/SidebarNav.tsx'),
    readSource('../src/layouts/admin-shell/ProjectsSidebarNav.tsx'),
    readSource('../src/layouts/admin-shell/KnowledgeSidebarNav.tsx'),
    readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx'),
  ]
  const styles = readSource('../src/styles.css')

  for (const sidebar of sidebars) {
    assert.match(sidebar, /nativeTouchShell = isReactNativeWebView\(\)/)
    assert.match(sidebar, /nativeTouchShell \? 'touch-sidebar' : ''/)
  }
  assert.match(styles, /\.touch-sidebar \.admin-sec-hdr/)
  assert.match(styles, /\.touch-sidebar \.admin-sb-item/)
  assert.match(styles, /\.touch-sidebar \.admin-sb-item\.sidebar-child/)
  assert.match(styles, /\.touch-sidebar \.sidebar-project-tile/)
  assert.match(styles, /\.touch-sidebar \.admin-sec-hdr\s*\{[\s\S]*?min-height: 38px[\s\S]*?font-size: 14px/)
  assert.match(styles, /\.touch-sidebar \.admin-sb-item\s*\{[\s\S]*?min-height: 38px[\s\S]*?font-size: 14px/)
  assert.doesNotMatch(styles, /@media \(any-pointer: coarse\)/)
})

test('project folder rows become bold only in the touch sidebar', () => {
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const starred = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')

  assert.match(projects, /admin-sb-item sidebar-project-tile group/)
  assert.match(starred, /admin-sb-item sidebar-project-tile group/)
})

test('avatar tiles are rounded squares and touch navigation uses sidebar-coloured presence cutouts', () => {
  const people = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')
  const starred = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')
  const avatar = readSource('../src/components/primitives/UserAvatar.tsx')
  const agentAvatar = readSource('../src/components/shared/AgentAvatar.tsx')
  const workspaceAvatar = readSource('../src/components/primitives/WorkspaceAvatar.tsx')
  const badge = readSource('../src/components/primitives/PresenceBadge.tsx')

  assert.match(people, /presenceRingWidth=\{nativeTouchShell \? 3 : undefined\}/)
  assert.match(people, /ringColor=\{nativeTouchShell \? 'var\(--sb\)' : undefined\}/)
  assert.match(people, /showStatus=\{!nativeTouchShell\}/)
  assert.match(starred, /showPresence=\{nativeTouchShell\}/)
  assert.match(starred, /showStatus=\{!nativeTouchShell\}/)
  assert.match(avatar, /rounded-md/)
  assert.match(agentAvatar, /rounded-md/)
  assert.match(workspaceAvatar, /rounded-md/)
  assert.doesNotMatch(avatar, /shape/)
  assert.doesNotMatch(agentAvatar, /shape/)
  assert.doesNotMatch(people, /shape=/)
  assert.doesNotMatch(starred, /shape=/)
  assert.match(badge, /ringWidth = 2/)
})

test('the native phone home chrome delegates workspace, history, account, and Channels creation actions to the web shell', () => {
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const account = readSource('../src/layouts/admin-shell/UserMenuTrigger.tsx')
  const creation = readSource('../src/layouts/admin-shell/NativePhoneCreationBridge.tsx')
  const phoneChrome = readSource('../../mobile/src/components/NativePhoneConversationMenuChrome.tsx')
  const nativeApp = readSource('../../mobile/App.tsx')

  assert.match(shell, /useNativePhoneApp/)
  assert.match(shell, /\|\| pathname === '\/search'/)
  assert.match(shell, /<WorkspaceSwitcher variant="native-bridge" \/>/)
  assert.match(shell, /<NativeIPadToolbarBridge \/>/)
  assert.match(shell, /<UserMenuTrigger nativeShellBridge/)
  assert.match(account, /__nessieToggleAccountMenu/)
  assert.match(account, /type: 'nessie:account'/)
  assert.match(account, /userPresence: selfPresence\?\.state \?\? 'offline'/)
  assert.match(creation, /onCreateProject\(\)/)
  assert.match(creation, /onCreateChannel\(\)/)
  assert.match(creation, /onCreateMessage\(\)/)
  assert.match(nativeApp, /showNativePhoneHomeChrome = showBar && !IS_IPAD && isNativePhoneTabRootRoute\(currentPath\)/)
  assert.match(
    nativeApp,
    /showNativePhoneCreationActions = showNativePhoneHomeChrome && isNativePhoneChannelsRootRoute\(currentPath\)/,
  )
  assert.match(nativeApp, /creationAccentColor=\{strongAccent\}/)
  assert.match(nativeApp, /showCreationActions=\{showNativePhoneCreationActions\}/)
  assert.match(phoneChrome, /\{showCreationActions && !creationOpen \? \(/)
  assert.match(phoneChrome, /Start a new channel, project, or direct message/)
  assert.match(phoneChrome, /backgroundColor: creationAccentColor/)
  assert.match(phoneChrome, /Project/)
  assert.match(phoneChrome, /Channel/)
  assert.match(phoneChrome, /Message/)
})

test('sidebar action menus have room to read and tap their choices', () => {
  const styles = readSource('../src/styles.css')

  assert.match(styles, /\.admin-sidebar-menu\s*\{[\s\S]*?border-radius: 12px[\s\S]*?padding: 6px/)
  assert.match(styles, /\.admin-sidebar-menu button\s*\{[\s\S]*?border-radius: 8px[\s\S]*?padding: 10px 12px/)
  assert.match(
    styles,
    /\.admin-sidebar-menu \[role="button"\]\s*\{[\s\S]*?border-radius: 8px[\s\S]*?padding: 10px 12px/,
  )
})
