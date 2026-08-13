import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectSelectionClassName } from '../src/layouts/admin-shell/SidebarRow'

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

test('selected sidebar affordances follow the project selection hierarchy', () => {
  const styles = readSource('../src/styles.css')
  const row = readSource('../src/layouts/admin-shell/SidebarRow.tsx')
  const channels = readSource('../src/layouts/admin-shell/SidebarChannelsSection.tsx')
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const starred = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')
  const assistant = readSource('../src/components/features/personal-assistant/PersonalAssistantSurface.tsx')

  assert.match(styles, /\.admin-sb-item\.active svg/)
  assert.match(styles, /\.admin-sb-item\.active \.sidebar-row-symbol/)
  assert.match(styles, /\.admin-sb-item\.active \.sidebar-row-star/)
  assert.match(
    styles,
    /\.admin-sb-item\.active \.sidebar-row-star\s*\{\s*color: var\(--tx\)/,
  )
  assert.match(
    styles,
    /\.admin-sb-item\.active \.sidebar-pa-badge[\s\S]*?color: var\(--tx\)/,
  )
  assert.match(
    styles,
    /\.admin-sb-item\.active\s*\{[\s\S]*?background: color-mix\(in srgb, var\(--sb-active\) 20%, transparent\)/,
  )
  assert.match(
    styles,
    /\.admin-sb-item\.active-parent\s*\{[\s\S]*?background: color-mix\(in srgb, var\(--sb-active\) 10%, transparent\)/,
  )
  assert.match(row, /sidebar-row-symbol/)
  assert.equal(projectSelectionClassName('project-1', 'project-1'), 'active')
  assert.equal(projectSelectionClassName('project-1', 'project-1', 'channel-1'), 'active-parent')
  assert.equal(projectSelectionClassName('project-1', 'project-2'), '')
  assert.match(channels, /sidebar-row-star/)
  assert.match(projects, /projectSelectionClassName\(project\.id, currentProjectId, currentChannelId\)/)
  assert.match(starred, /projectSelectionClassName\(project\.id, currentProjectId, currentChannelId\)/)
  assert.match(assistant, /sidebar-pa-badge/)
})

test('secondary sidebar menus do not repeat the active tab title above their items', () => {
  const projects = readSource('../src/layouts/admin-shell/ProjectsSidebarNav.tsx')
  const knowledge = readSource('../src/layouts/admin-shell/KnowledgeSidebarNav.tsx')
  const admin = readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx')

  assert.doesNotMatch(projects, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Projects<\/span>/)
  assert.doesNotMatch(knowledge, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Knowledge<\/span>/)
  assert.doesNotMatch(admin, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Admin<\/span>/)
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
  const mobileShell = readSource('../src/lib/mobile-shell.ts')
  const phoneChrome = readSource('../../mobile/src/components/NativePhoneConversationMenuChrome.tsx')
  const ipadWorkspace = readSource('../../mobile/src/components/IpadNativeWorkspaceSwitcher.tsx')
  const nativeWorkspaceAvatar = readSource('../../mobile/src/components/NativeWorkspaceAvatar.tsx')
  const workspaceSwitcher = readSource('../src/layouts/admin-shell/WorkspaceSwitcher.tsx')
  const nativeApp = readSource('../../mobile/App.tsx')

  assert.match(shell, /useNativePhoneApp/)
  assert.match(shell, /\|\| pathname === '\/search'/)
  assert.match(shell, /<WorkspaceSwitcher variant="native-bridge" \/>/)
  assert.match(shell, /<NativeIPadToolbarBridge \/>/)
  assert.match(shell, /<UserMenuTrigger nativeShellBridge/)
  assert.match(account, /__nessieToggleAccountMenu/)
  assert.match(account, /type: 'nessie:account'/)
  assert.match(account, /userPresence: selfPresence\?\.state \?\? 'offline'/)
  assert.match(mobileShell, /requestNativeFullRefresh/)
  assert.match(mobileShell, /type: 'nessie:full-refresh'/)
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
  assert.match(phoneChrome, /const AnimatedPressable = Animated\.createAnimatedComponent\(Pressable\)/)
  assert.match(phoneChrome, /Animated\.timing\(creationProgress,/)
  assert.match(phoneChrome, /styles\.morphingMessageAction/)
  assert.match(phoneChrome, /Open creation menu/)
  assert.match(phoneChrome, /messageActionSlot/)
  assert.doesNotMatch(phoneChrome, /Start a new channel, project, or direct message/)
  assert.match(phoneChrome, /createDescription: \{ fontSize: 10, lineHeight: 13 \}/)
  assert.match(phoneChrome, /createTitle: \{ fontSize: 14, fontWeight: '700', lineHeight: 17 \}/)
  assert.match(phoneChrome, /messageActionText: \{ fontSize: 15, fontWeight: '700', lineHeight: 18 \}/)
  assert.match(phoneChrome, /backgroundColor: creationAccentColor/)
  assert.match(phoneChrome, /Project/)
  assert.match(phoneChrome, /Channel/)
  assert.match(phoneChrome, /Message/)
  assert.match(workspaceSwitcher, /workspaceAvatarUrl: active\?\.avatarImageUrl \?\? null/)
  assert.match(nativeApp, /setNativeWorkspaceAvatarUrl/)
  assert.match(nativeApp, /workspaceAvatarUrl=\{nativeWorkspaceAvatarUrl\}/)
  assert.match(phoneChrome, /<NativeWorkspaceAvatar/)
  assert.match(ipadWorkspace, /<NativeWorkspaceAvatar/)
  assert.match(nativeWorkspaceAvatar, /source=\{\{ uri: imageUrl \?\? undefined \}\}/)
  assert.match(nativeWorkspaceAvatar, /onError=\{\(\) => setFailedUrl\(imageUrl\)\}/)
})

test('the native Admin actions offer session debugging above a cache-busting full refresh', () => {
  const adminNav = readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx')
  const debugButton = readSource('../src/components/shared/DebugTokenButton.tsx')
  const nativeApp = readSource('../../mobile/App.tsx')

  assert.match(adminNav, /isReactNativeWebView\(\) \? \(/)
  assert.match(adminNav, /<DebugTokenButton variant="sidebar" \/>/)
  assert.match(adminNav, /onClick=\{requestNativeFullRefresh\}/)
  assert.ok(adminNav.indexOf('<DebugTokenButton variant="sidebar" />') < adminNav.indexOf('Full refresh'))
  assert.match(debugButton, /variant\?: 'rail' \| 'sidebar'/)
  assert.match(debugButton, /Session debug/)
  assert.match(adminNav, /Full refresh/)
  assert.match(nativeApp, /msg.type === 'nessie:full-refresh'/)
  assert.match(nativeApp, /setReloadPath\(currentPathRef.current\)/)
  assert.match(nativeApp, /setWebviewKey\(\(key\) => key \+ 1\)/)
})

test('Safari and Android browser tab roots reuse the mobile workspace, recents, and account controls', () => {
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const header = readSource('../src/layouts/admin-shell/MobileWebHomeHeader.tsx')
  const workspace = readSource('../src/layouts/admin-shell/WorkspaceSwitcher.tsx')

  assert.match(shell, /showMobileWebHomeHeader = showWebTabBar && showPhoneTabRoot/)
  assert.match(shell, /<MobileWebHomeHeader onLogout=\{shell.logoutAndRedirect\} \/>/)
  assert.match(header, /<WorkspaceSwitcher variant="mobile-header" \/>/)
  assert.match(header, /<RecentChannelsControl/)
  assert.match(header, /<UserMenuTrigger/)
  assert.match(workspace, /variant\?: 'mobile-header' \| 'native-bridge' \| 'rail'/)
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
