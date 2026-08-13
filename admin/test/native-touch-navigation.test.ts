import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('native touch shells use Slack-scale sidebar density while desktop remains compact', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarNav.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(sidebar, /nativeTouchShell = isReactNativeWebView\(\)/)
  assert.match(sidebar, /nativeTouchShell \? 'touch-sidebar' : ''/)
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

test('touch navigation uses rounded avatar tiles and sidebar-coloured presence cutouts', () => {
  const people = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')
  const starred = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')
  const avatar = readSource('../src/components/primitives/UserAvatar.tsx')
  const badge = readSource('../src/components/primitives/PresenceBadge.tsx')

  assert.match(people, /presenceRingWidth=\{nativeTouchShell \? 3 : undefined\}/)
  assert.match(people, /ringColor=\{nativeTouchShell \? 'var\(--sb\)' : undefined\}/)
  assert.match(people, /shape=\{nativeTouchShell \? 'rounded' : 'circle'\}/)
  assert.match(people, /showStatus=\{!nativeTouchShell\}/)
  assert.match(starred, /showPresence=\{nativeTouchShell\}/)
  assert.match(starred, /showStatus=\{!nativeTouchShell\}/)
  assert.match(avatar, /shape === 'rounded' \? 'rounded-lg' : 'rounded-full'/)
  assert.match(badge, /ringWidth = 2/)
})

test('the iPhone native menu delegates workspace, history, account, and creation actions to the web shell', () => {
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const account = readSource('../src/layouts/admin-shell/UserMenuTrigger.tsx')
  const creation = readSource('../src/layouts/admin-shell/NativePhoneCreationBridge.tsx')
  const phoneChrome = readSource('../../mobile/src/components/IphoneConversationMenuChrome.tsx')

  assert.match(shell, /useNativeIOSPhoneApp/)
  assert.match(shell, /<WorkspaceSwitcher variant="native-bridge" \/>/)
  assert.match(shell, /<NativeIPadToolbarBridge \/>/)
  assert.match(shell, /<UserMenuTrigger nativePhoneBridge/)
  assert.match(account, /__nessieTogglePhoneAccountMenu/)
  assert.match(account, /type: 'nessie:phone-account'/)
  assert.match(account, /userPresence: selfPresence\?\.state \?\? 'offline'/)
  assert.match(creation, /onCreateProject\(\)/)
  assert.match(creation, /onCreateChannel\(\)/)
  assert.match(creation, /onCreateMessage\(\)/)
  assert.match(phoneChrome, /Project/)
  assert.match(phoneChrome, /Channel/)
  assert.match(phoneChrome, /Message/)
})
