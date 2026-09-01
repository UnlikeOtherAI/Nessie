import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  getPhoneNavigationBackTarget,
  getPhoneNavigationDirection,
  getPhoneNavigationScreen,
  shouldHighlightKnowledgeSidebarSelection,
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

test('the full-screen phone thread owns the shared Back doorway', () => {
  const threadPanel = readSource(
    '../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
  )

  assert.match(threadPanel, /import \{ usePhoneLayout \} from '[^']*mobile-shell'/)
  assert.match(
    threadPanel,
    /import \{ PhoneBackButton \} from '[^']*layouts\/admin-shell\/PhoneBackButton'/,
  )
  assert.match(threadPanel, /const phoneLayout = usePhoneLayout\(\)/)
  assert.match(
    threadPanel,
    /phoneLayout \? \([\s\S]*?<PhoneBackButton label="Back to channel" onBack=\{closeThread\} \/>/,
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

test('clears the Knowledge space highlight when a phone returns to its list', () => {
  assert.equal(shouldHighlightKnowledgeSidebarSelection('/knowledge-base', true), false)
  assert.equal(shouldHighlightKnowledgeSidebarSelection('/knowledge-base/spaces/space_a', true), true)
  assert.equal(shouldHighlightKnowledgeSidebarSelection('/knowledge-base', false), true)
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
    getPhoneNavigationDirection('/agents/triggers', '/settings'),
    'back',
  )
})

test('keeps routes on the same screen from replaying a navigation transition', () => {
  // The channel info chain stays one screen identity (channel A → B at any
  // depth swaps content in place); deeper pages still animate by depth.
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/channel_a/info',
      '/channels/channel_a/info/members',
    ),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/channel_a/info/members',
      '/channels/channel_a/info',
    ),
    'back',
  )
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/channel_a/info',
      '/channels/channel_b/info',
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

test('does not animate cross-tab or unrelated routes', () => {
  assert.equal(getPhoneNavigationDirection('/channels', '/projects'), null)
  assert.equal(getPhoneNavigationDirection('/projects', '/settings'), null)
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/agents/agent_a'), null)
  // Compose is a Flow inside Channels: it pushes over the root like any other
  // depth-1 screen, and swaps in place beside a conversation.
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/new'), 'forward')
  assert.equal(getPhoneNavigationScreen('/channels/new')?.depth, 1)
})

test('pushes and pops the Agents family and the settings/ops nested details', () => {
  assert.equal(getPhoneNavigationDirection('/agents', '/agents/agent_a'), 'forward')
  assert.equal(getPhoneNavigationDirection('/agents/agent_a', '/agents'), 'back')
  assert.equal(getPhoneNavigationDirection('/agents', '/agents/designer/agent_a'), 'forward')
  assert.equal(
    getPhoneNavigationDirection('/settings/statuses', '/settings/statuses/status_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/settings/statuses/status_a', '/settings/statuses'),
    'back',
  )
  assert.equal(getPhoneNavigationDirection('/ops', '/ops/usage'), 'forward')
  assert.equal(getPhoneNavigationDirection('/ops/usage', '/ops'), 'back')
  // /threads and /unread-messages sit one step inside Channels.
  assert.equal(getPhoneNavigationDirection('/channels', '/threads'), 'forward')
  assert.equal(getPhoneNavigationDirection('/threads', '/channels'), 'back')
})

test('classifies channel project overviews before the generic channel pattern', () => {
  assert.deepEqual(getPhoneNavigationScreen('/channels/projects/project_a'), {
    depth: 1,
    key: 'channels:projects',
    section: 'channels',
  })
})

test('gives every phone detail route a deterministic in-app Back destination', () => {
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/projects/project_a'),
    { label: 'Back to Channels', pathname: '/channels' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/channel_a/info'),
    { label: 'Back to conversation', pathname: '/channels/channel_a' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/channel_a/info/members'),
    { label: 'Back to channel info', pathname: '/channels/channel_a/info' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/channel_a/info/members/add'),
    { label: 'Back to members', pathname: '/channels/channel_a/info/members' },
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
    getPhoneNavigationBackTarget('/agents/triggers'),
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
  // Feedback and Alerts are reachable from every section, so their declared
  // parent is Admin — where both are listed — and the ledger's real
  // predecessor wins over it whenever there is one.
  assert.deepEqual(
    getPhoneNavigationBackTarget('/feedback'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/alerts'),
    { label: 'Back to Admin', pathname: '/settings' },
  )
  assert.deepEqual(
    getPhoneNavigationBackTarget('/threads'),
    { label: 'Back to Channels', pathname: '/channels' },
  )
})

test('keeps the drawer control at phone section roots', () => {
  for (const pathname of [
    '/channels',
    '/projects',
    '/knowledge-base',
    '/settings',
    '/search',
  ]) {
    assert.equal(getPhoneNavigationBackTarget(pathname), null)
  }
  // /dashboards is a Knowledge-section detail: its Back returns to Knowledge.
  assert.deepEqual(
    getPhoneNavigationBackTarget('/dashboards'),
    { label: 'Back to Knowledge', pathname: '/knowledge-base' },
  )
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
  assert.match(knowledgeSidebar, /shouldHighlightKnowledgeSidebarSelection/)
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

  assert.match(navigationButton, /resolveBackAction\(/)
  assert.match(navigationButton, /<PhoneBackButton/)
  assert.match(backButton, /useNativeIOSPhoneApp/)
  assert.match(channelHeader, /leading=\{<PhoneNavigationButton \/>\}/)
  assert.match(composePage, /<PhoneBackButton label="Back to Channels" onBack=\{close\}/)
  assert.match(infoFlow, /<PhoneNavigationButton \/>/)
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

test('navigation motion is scripted from static poses, never a CSS keyframe', () => {
  const styles = readSource('../src/styles.css')

  // The poses a layer rests in; the travel between them is runStackTransition.
  assert.match(styles, /\.phone-navigation-screen--forward-ready \{[\s\S]*?transform: translate3d\(100%, 0, 0\)/)
  assert.match(styles, /\.phone-navigation-screen--underlay \{[\s\S]*?calc\(-1 \* var\(--nav-parallax\)\)/)
  assert.equal((styles.match(/@keyframes phone-navigation-/g) ?? []).length, 0)
  assert.doesNotMatch(styles, /\.phone-navigation-screen[^{]*\{[^}]*animation/)

  const viewport = readSource('../src/layouts/admin-shell/PhoneNavigationViewport.tsx')
  const swipe = readSource('../src/layouts/admin-shell/use-phone-back-swipe.ts')
  assert.match(viewport, /runStackTransition\(/)
  assert.match(swipe, /runStackTransition\(/)
  assert.doesNotMatch(swipe, /\.animate\(/)
  assert.doesNotMatch(viewport, /onAnimationEnd/)
})

test('stack containers clip rather than hide, so no descendant can scroll them', () => {
  // A hidden-overflow box is still a scroll container: TabBar's mount-time
  // scrollIntoView() inside a screen parked at translate3d(100%) scrolled the
  // viewport sideways, and the compositor landed the slide short by that
  // offset until the next layout clamped it — the "bounce". `clip` is not a
  // scroll container. Reproduction: docs/plans/2026-09-01-navigation-motion-system/repro.mjs
  const styles = readSource('../src/styles.css')
  const viewportRule = styles.slice(
    styles.indexOf('.phone-navigation-viewport {'),
    styles.indexOf('.phone-navigation-page {'),
  )
  assert.match(viewportRule, /\.phone-navigation-viewport \{[\s\S]*?overflow: clip;/)
  assert.match(viewportRule, /\.phone-navigation-screen \{[\s\S]*?overflow: clip;/)
  assert.doesNotMatch(viewportRule, /overflow: hidden/)

  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  assert.match(shell, /<main className="min-w-0 flex-1 overflow-clip/)

  const columnBrowser = readSource(
    '../src/components/shared/column-browser/ColumnBrowserViewport.tsx',
  )
  assert.match(columnBrowser, /<div className="h-full w-full overflow-clip">/)

  const tabBar = readSource('../src/components/primitives/TabBar.tsx')
  assert.doesNotMatch(tabBar, /\.scrollIntoView\(/)
  assert.match(tabBar, /track\.scrollLeft/)
})
