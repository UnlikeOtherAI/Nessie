import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectSelectionClassName } from '../src/layouts/admin-shell/SidebarRow'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const readCssBlock = (source: string, marker: string): string => {
  const markerIndex = source.indexOf(marker)
  assert.notEqual(markerIndex, -1, `Missing CSS rule: ${marker}`)
  const openingBrace = source.indexOf('{', markerIndex)
  assert.notEqual(openingBrace, -1, `Missing opening brace for: ${marker}`)

  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] !== '}') continue
    depth -= 1
    if (depth === 0) return source.slice(openingBrace + 1, index)
  }

  assert.fail(`Missing closing brace for: ${marker}`)
}

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
  const coarsePointerStyles = readCssBlock(styles, '@media (any-pointer: coarse)')
  assert.match(coarsePointerStyles, /\.admin-compose-action/)
  assert.doesNotMatch(
    coarsePointerStyles,
    /\.touch-sidebar|\.admin-sec-hdr|\.admin-sb-item|\.sidebar-project-tile/,
  )
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
  assert.match(assistant, /sidebar-row-star/)
})

test('secondary sidebar menus do not repeat the active tab title above their items', () => {
  const projects = readSource('../src/layouts/admin-shell/ProjectsSidebarNav.tsx')
  const knowledge = readSource('../src/layouts/admin-shell/KnowledgeSidebarNav.tsx')
  const admin = readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx')

  assert.doesNotMatch(projects, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Projects<\/span>/)
  assert.doesNotMatch(knowledge, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Knowledge<\/span>/)
  assert.doesNotMatch(admin, /text-\[15px\] font-bold text-\[color:var\(--tx\)\]">Admin<\/span>/)
})

test('project action menus render in the document overlay layer instead of the clipped sidebar', () => {
  const sidebarProjects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const projectNavigation = readSource('../src/layouts/admin-shell/ProjectsSidebarNav.tsx')

  assert.match(sidebarProjects, /createPortal\(/)
  assert.match(sidebarProjects, /document\.body/)
  assert.match(sidebarProjects, /admin-sidebar-menu-project fixed z-\[61\]/)
  assert.match(sidebarProjects, /setMenuPosition\(\{ left: rect\.left, top: rect\.bottom \}\)/)
  assert.match(sidebarProjects, /window\.addEventListener\('scroll', closeOnViewportChange, true\)/)
  assert.match(projectNavigation, /createPortal\(/)
  assert.match(projectNavigation, /document\.body/)
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
  assert.match(people, /showStatus=\{false\}/)
  assert.match(people, /<UserStatusEmoji/)
  assert.match(starred, /showPresence=\{nativeTouchShell\}/)
  assert.match(starred, /showStatus=\{false\}/)
  assert.match(starred, /<UserStatusEmoji/)
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
  const accountPopover = readSource('../src/layouts/admin-shell/UserMenuPopover.tsx')
  const creation = readSource('../src/layouts/admin-shell/NativePhoneCreationBridge.tsx')
  const mobileShell = readSource('../src/lib/mobile-shell.ts')
  const phoneChrome = readSource('../../mobile/src/components/NativePhoneConversationMenuChrome.tsx')
  const phoneHeader = readSource('../../mobile/src/components/NativePhoneHeader.tsx')
  const phoneNavigationProvider = readSource('../src/layouts/admin-shell/PhoneNavigationProvider.tsx')
  const ipadWorkspace = readSource('../../mobile/src/components/IpadNativeWorkspaceSwitcher.tsx')
  const nativeWorkspaceAvatar = readSource('../../mobile/src/components/NativeWorkspaceAvatar.tsx')
  const nativePresentation = readSource('../../mobile/src/components/native-shell-presentation.ts')
  const workspaceSwitcher = readSource('../src/layouts/admin-shell/WorkspaceSwitcher.tsx')
  const nativeApp = readSource('../../mobile/App.tsx')

  assert.match(shell, /useNativePhoneApp/)
  assert.match(shell, /useNativeLargePhoneLandscapeApp/)
  assert.match(shell, /ResizableSidebar fixed=\{nativeLargePhoneLandscape\}/)
  // The tab-root set (channels/projects/knowledge/settings/search) lives in
  // the shared phone-navigation module so shell, tab bar, and Back agree.
  assert.match(shell, /isPhoneTabRoot,/)
  const phoneNav = readSource('../src/layouts/admin-shell/phone-navigation.ts')
  assert.ok(phoneNav.includes(String.raw`/^\/search$/`))
  assert.match(shell, /<WorkspaceSwitcher variant="native-bridge" \/>/)
  assert.match(shell, /<NativeIPadToolbarBridge \/>/)
  assert.match(shell, /<UserMenuTrigger\s+nativeShellBridge/)
  assert.match(account, /__nessieToggleAccountMenu/)
  assert.match(account, /__nessieToggleFocusMode/)
  assert.match(accountPopover, /to="\/feedback"/)
  assert.match(accountPopover, /<span>Feedback<\/span>/)
  assert.match(accountPopover, /<DebugTokenButton variant="menu" \/>/)
  assert.doesNotMatch(account, /showFeedbackLink/)
  assert.match(account, /type: 'nessie:account'/)
  assert.match(account, /userPresence: selfPresence\?\.state \?\? 'offline'/)
  assert.match(account, /userFocusMode: focusModeEnabled/)
  assert.match(phoneHeader, /accountFocusModeEnabled/)
  assert.match(phoneHeader, /NativeFocusModeButton/)
  assert.match(nativeApp, /onToggleFocusMode=\{nativeActions\.toggleFocusMode\}/)
  assert.match(mobileShell, /requestNativeFullRefresh/)
  assert.match(mobileShell, /type: 'nessie:full-refresh'/)
  assert.match(creation, /onCreateProject\(\)/)
  assert.match(creation, /onCreateChannel\(\)/)
  assert.match(creation, /onCreateMessage\(\)/)
  assert.match(nativeApp, /shouldShowNativePhoneHeader\(/)
  assert.match(nativeApp, /largePhoneLandscapeCapable/)
  assert.match(nativeApp, /large-phone-landscape/)
  assert.match(
    nativeApp,
    /showNativePhoneCreationActions = showNativePhoneHeader/,
  )
  assert.match(nativeApp, /landscape=\{largePhoneLandscape\}/)
  assert.match(phoneNavigationProvider, /useNativeLargePhoneLandscapeApp/)
  assert.match(phoneNavigationProvider, /returnedToPortrait/)
  assert.match(phoneNavigationProvider, /getPhoneTabRootPath\(location\.pathname\)/)
  assert.match(nativeApp, /creationAccentColor=\{strongAccent\}/)
  assert.match(nativeApp, /showCreationActions=\{showNativePhoneCreationActions\}/)
  assert.match(phoneChrome, /const AnimatedPressable = Animated\.createAnimatedComponent\(Pressable\)/)
  assert.match(phoneChrome, /Animated\.timing\(creationProgress,/)
  assert.match(phoneChrome, /styles\.morphingMessageAction/)
  assert.match(phoneChrome, /Open creation menu/)
  assert.match(phoneHeader, /accessibilityLabel="Back"/)
  assert.match(phoneHeader, /accessibilityLabel="Forward"/)
  assert.match(phoneHeader, /onToolbarAction\('history'\)/)
  assert.match(phoneHeader, /landscape \? \(/)
  assert.match(phoneHeader, /getNativePhoneHeaderHeight\(landscape\)/)
  assert.match(phoneHeader, /paddingHorizontal: NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER/)
  assert.doesNotMatch(phoneChrome, /openSearchOverlay/)
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
  assert.match(nativePresentation, /workspaceAvatarUrl: optionalText\(message\.workspaceAvatarUrl\)/)
  assert.match(nativeApp, /workspaceAvatarUrl=\{nativeWorkspaceAvatarUrl\}/)
  assert.match(phoneHeader, /<NativeWorkspaceAvatar/)
  assert.ok(
    phoneHeader.indexOf('accessibilityLabel={`Switch workspace')
      < phoneHeader.indexOf('<NativePhoneToolbarControls')
      && phoneHeader.indexOf('<NativePhoneToolbarControls')
        < phoneHeader.lastIndexOf('accessibilityLabel="Account menu"'),
  )
  assert.match(ipadWorkspace, /<NativeWorkspaceAvatar/)
  assert.match(nativeWorkspaceAvatar, /const useAvatarImageSource/)
  assert.match(nativeWorkspaceAvatar, /<SvgXml height=\{size\} width=\{size\} xml=\{source\.xml\} \/>/)
  assert.match(nativeWorkspaceAvatar, /source=\{\{ uri: source\.uri \}\}/)
  assert.match(nativeWorkspaceAvatar, /onError=\{\(\) => setFailedRasterUrl\(source\.uri\)\}/)
})

test('the account popover places Feedback and Debug between status and account actions', () => {
  const popover = readSource('../src/layouts/admin-shell/UserMenuPopover.tsx')
  const trigger = readSource('../src/layouts/admin-shell/UserMenuTrigger.tsx')

  assert.doesNotMatch(popover, /MeAuth|providerLabel|account\)\}/)
  assert.doesNotMatch(trigger, /auth=\{me\.auth\}/)
  const status = popover.indexOf('<StatusSection onClose={onClose} />')
  const feedback = popover.indexOf('to="/feedback"')
  const debug = popover.indexOf('<DebugTokenButton variant="menu" />')
  const accountSettings = popover.indexOf('to="/settings/profile"')

  assert.ok(status < feedback)
  assert.ok(feedback < debug)
  assert.ok(debug < accountSettings)
  assert.match(
    popover.slice(debug, accountSettings),
    /<div className="my-1 h-px bg-\[color:var\(--sep\)\]" \/>/,
  )
})

test('the native Admin actions retain the cache-busting full refresh', () => {
  const adminNav = readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx')
  const nativeApp = readSource('../../mobile/App.tsx')
  // The boot-recovery state machine moved into its own hook; App.tsx wires the
  // `nessie:full-refresh` message to it.
  const bootRecovery = readSource('../../mobile/src/lib/use-native-boot-recovery.ts')

  assert.match(adminNav, /isReactNativeWebView\(\) \? \(/)
  assert.match(adminNav, /onClick=\{requestNativeFullRefresh\}/)
  assert.doesNotMatch(adminNav, /DebugTokenButton/)
  assert.match(adminNav, /Full refresh/)
  assert.match(nativeApp, /msg.type === 'nessie:full-refresh'/)
  assert.match(nativeApp, /bootRecovery\.fullRefreshWebView\(\)/)
  assert.match(bootRecovery, /setReloadPath\(currentPathRef.current\)/)
  assert.match(bootRecovery, /setWebviewKey\(\(key\) => key \+ 1\)/)
})

test('the native phone shell clears the glass tab bar within the WebView content', () => {
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const phoneViewport = readSource('../src/layouts/admin-shell/PhoneNavigationViewport.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(shell, /showNativePhoneTabBar = nativePhoneApp && !isComposeRoute/)
  assert.match(shell, /showNativePhoneTabBar \? 'has-native-phone-tabbar' : ''/)
  assert.match(phoneViewport, /className="phone-navigation-page"/)
  assert.match(phoneViewport, /data-phone-navigation-page/)
  assert.match(
    styles,
    /\.phone-navigation-page\s*\{[\s\S]*?overflow-y: auto[\s\S]*?overscroll-behavior-y: contain/,
  )
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
  assert.doesNotMatch(header, /showFeedbackLink/)
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

test('an open project action menu dismisses when the person taps outside it', () => {
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')

  assert.match(projects, /className="fixed inset-0 z-\[60\] cursor-default"/)
  assert.match(projects, /closeProjectMenu\(\)/)
})
