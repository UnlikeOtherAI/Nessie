import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  getPhoneNavigationBackTarget,
  getPhoneNavigationDirection,
  getPhoneNavigationScreen,
} from '../src/layouts/admin-shell/phone-navigation'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('pushes channel and channel-project details forward from the Channels root', () => {
  assert.equal(
    getPhoneNavigationDirection('/channels', '/channels/channel_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/channels/', '/channels/projects/project_a'),
    'forward',
  )
})

test('pops channel details back even when Back navigates to an explicit URL', () => {
  assert.equal(
    getPhoneNavigationDirection('/channels/channel_a', '/channels'),
    'back',
  )
  assert.equal(
    getPhoneNavigationDirection('/channels/channel_a/info/members', '/channels'),
    'back',
  )
  assert.equal(
    getPhoneNavigationDirection('/channels/projects/project_a', '/channels'),
    'back',
  )
})

test('pushes and pops project details within the Projects tab', () => {
  assert.equal(
    getPhoneNavigationDirection('/projects', '/projects/project_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/projects/project_a/board', '/projects'),
    'back',
  )
})

test('pushes Knowledge spaces and product views from the Knowledge list', () => {
  assert.equal(
    getPhoneNavigationDirection('/knowledge-base', '/knowledge-base/spaces/space_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/knowledge-base', '/knowledge-base/views/research'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/knowledge-base/spaces/space_a', '/knowledge-base'),
    'back',
  )
})

test('pushes Admin destinations from the Admin menu and returns to it', () => {
  assert.equal(
    getPhoneNavigationDirection('/settings', '/settings/security'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/settings', '/agents'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/agents/activity', '/settings'),
    'back',
  )
})

test('keeps routes on the same screen from replaying a navigation transition', () => {
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/channel_a',
      '/channels/channel_a/info/members',
    ),
    null,
  )
  assert.equal(
    getPhoneNavigationDirection('/projects/project_a', '/projects/project_a/docs'),
    null,
  )
  assert.equal(
    getPhoneNavigationDirection(
      '/knowledge-base/spaces/space_a',
      '/knowledge-base/spaces/space_b',
    ),
    null,
  )
  assert.equal(
    getPhoneNavigationDirection('/settings/security', '/settings/profile'),
    null,
  )
  assert.equal(
    getPhoneNavigationDirection('/channels/channel_a', '/channels/channel_b'),
    null,
  )
})

test('does not animate cross-tab, compose, or unrelated routes', () => {
  assert.equal(getPhoneNavigationDirection('/channels', '/projects'), null)
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/new'), null)
  assert.equal(getPhoneNavigationDirection('/projects', '/settings'), null)
  assert.equal(getPhoneNavigationScreen('/channels/new'), null)
})

test('classifies channel project overviews before the generic channel pattern', () => {
  assert.deepEqual(getPhoneNavigationScreen('/channels/projects/project_a'), {
    depth: 1,
    key: 'channels:project:project_a',
    section: 'channels',
  })
})

test('gives every phone detail route a deterministic in-app Back destination', () => {
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/projects/project_a'),
    { label: 'Back to Channels', pathname: '/channels' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/channel_a/info/members'),
    { label: 'Back to Channels', pathname: '/channels' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/projects/project_a/docs'),
    { label: 'Back to Projects', pathname: '/projects' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/dashboards/dashboard_a'),
    { label: 'Back to Dashboards', pathname: '/dashboards' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/agents/activity'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/agents'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/knowledge-base/spaces/space_a'),
    { label: 'Back to Knowledge', pathname: '/knowledge-base' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/settings/security'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/mcp-app-store'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/feedback'),
    { label: 'Back to Channels', pathname: '/channels' },
  )
})

test('keeps the drawer control at phone section roots', () => {
  for (const pathname of [
    '/channels',
    '/projects',
    '/dashboards',
    '/knowledge-base',
    '/settings',
    '/search',
  ]) {
    assert.equal(getPhoneNavigationBackTarget(pathname), null)
  }
})

test('routes phone Knowledge selections and Projects rows to stack details', () => {
  const router = readSource('../src/router.tsx')
  const knowledgeSidebar = readSource(
    '../src/layouts/admin-shell/KnowledgeSidebarNav.tsx',
  )
  const projectsSidebar = readSource(
    '../src/layouts/admin-shell/ProjectsSidebarNav.tsx',
  )

  assert.match(router, /path: '\/knowledge-base\/spaces\/:spaceId'/)
  assert.match(router, /path: '\/knowledge-base\/views\/:productView'/)
  assert.match(knowledgeSidebar, /usePhoneLayout/)
  assert.match(knowledgeSidebar, /navigate\(`\/knowledge-base\/spaces\//)
  assert.match(projectsSidebar, /usePhoneLayout/)
  assert.match(projectsSidebar, /`\/projects\/\$\{project\.id\}\/board`/)
})

test('shares the phone Back control across route headers and channel flows', () => {
  const navigationButton = readSource('../src/layouts/admin-shell/PhoneNavigationButton.tsx')
  const backButton = readSource('../src/layouts/admin-shell/PhoneBackButton.tsx')
  const channelHeader = readSource('../src/components/features/channels/ChannelHeader.tsx')
  const composePage = readSource('../src/pages/ChannelConversationComposePage.tsx')
  const infoFlow = readSource('../src/components/features/channels/ConversationInfoFlow.tsx')

  assert.match(navigationButton, /getPhoneNavigationBackTarget/)
  assert.match(navigationButton, /<PhoneBackButton/)
  assert.match(backButton, /useNativeIOSPhoneApp/)
  assert.match(channelHeader, /<PhoneBackButton label="Back to Channels"/)
  assert.match(composePage, /<PhoneBackButton label="Back to Channels" onBack=\{close\}/)
  assert.match(infoFlow, /<PhoneBackButton label="Back"/)
})

test('mounts the transition viewport only in the shell phone branch', () => {
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const phoneBranchStart = shell.indexOf('const contentRegion = phoneLayout ? (')
  const widerBranchStart = shell.indexOf('\n  ) : (\n    <>', phoneBranchStart)
  const viewport = shell.indexOf('<PhoneNavigationViewport', phoneBranchStart)

  assert.notEqual(phoneBranchStart, -1)
  assert.notEqual(widerBranchStart, -1)
  assert.ok(viewport > phoneBranchStart && viewport < widerBranchStart)
  assert.equal(shell.indexOf('<PhoneNavigationViewport', viewport + 1), -1)
})

test('defines paired push and pop animations under the global reduced-motion rule', () => {
  const styles = readSource('../src/styles.css')

  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(styles, /@keyframes phone-navigation-forward-out/)
  assert.match(styles, /@keyframes phone-navigation-forward-in/)
  assert.match(styles, /@keyframes phone-navigation-back-out/)
  assert.match(styles, /@keyframes phone-navigation-back-in/)
})
