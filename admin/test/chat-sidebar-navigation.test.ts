import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replaceAll('\r\n', '\n')

test('the direct-messages plus opens the recipient-addressed conversation composer', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')

  assert.match(source, /aria-label="Start new chat"/)
  assert.match(source, /onClick=\{onStartNewConversation\}/)
  assert.doesNotMatch(source, /onNavigateSettings/)
  assert.doesNotMatch(source, /Invite people/)
})

test('every sidebar section plus draws the shared icon, never a text glyph', () => {
  // `.admin-sidebar-nav .admin-sidebar-plus` sets font-size: 0 so only the svg
  // shows; a text "+" in any section action renders as an empty square.
  for (const file of ['SidebarDmSection.tsx', 'SidebarChannelsSection.tsx', 'SidebarProjectsSection.tsx']) {
    const source = readSource(`../src/layouts/admin-shell/${file}`)

    assert.match(source, /<SidebarPlusIcon \/>/, file)
    assert.doesNotMatch(source, /className="admin-sidebar-plus"[^>]*>\s*\+\s*</, file)
  }
})

test('chat navigation does not duplicate the Agents activity section', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarNav.tsx')

  assert.doesNotMatch(source, /AgentActivityPanel/)
  assert.doesNotMatch(source, /sidebar-nav-agents/)
})

test('the organisation-wide channel section names its shared scope', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarChannelsSection.tsx')

  assert.match(source, /title="Shared channels"/)
})

test('section titles truncate instead of wrapping in a narrow Channels sidebar', () => {
  const menuSection = readSource('../src/layouts/admin-shell/SidebarMenuSection.tsx')
  const styles = readSource('../src/styles.css')
  const titleRuleStart = styles.indexOf('.admin-sidebar-nav .sidebar-menu-section-title {')
  const titleRule = styles.slice(titleRuleStart, styles.indexOf('}', titleRuleStart))

  assert.match(menuSection, /className="sidebar-menu-section-title"/)
  assert.notEqual(titleRuleStart, -1)
  assert.match(titleRule, /overflow: hidden;/)
  assert.match(titleRule, /text-overflow: ellipsis;/)
  assert.match(titleRule, /white-space: nowrap;/)
  assert.match(
    styles,
    /\.admin-sidebar-nav \.admin-sec-hdr\s*\{[\s\S]*?flex: 1;[\s\S]*?min-width: 0;/,
  )
})

test('the Channels sidebar adopts the compact guided tree geometry', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarNav.tsx')
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(sidebar, /admin-sb-item sidebar-threads group/)
  assert.doesNotMatch(sidebar, /sidebar-top-level/)
  assert.match(projects, /className="sidebar-project-group"/)
  assert.match(projects, /className="sidebar-project-children"/)
  assert.match(
    styles,
    /\.admin-sidebar-nav \.admin-sidebar-scroll\s*\{[\s\S]*?padding: 14px 16px 14px 4px;/,
  )
  const projectChildrenStart = styles.indexOf('.admin-sidebar-nav .sidebar-project-children {')
  const projectChildrenRule = styles.slice(
    projectChildrenStart,
    styles.indexOf('}', projectChildrenStart),
  )
  assert.notEqual(projectChildrenStart, -1)
  assert.match(projectChildrenRule, /margin-left: 21px;/)
  assert.match(projectChildrenRule, /padding-left: 6px;/)
  assert.match(projectChildrenRule, /border-left: 1px solid var\(--sep\);/)
  assert.match(
    styles,
    /\.admin-sidebar-nav \.admin-sb-item\.sidebar-threads\s*\{[\s\S]*?min-height: 32px;[\s\S]*?padding: 0 10px;/,
  )
  assert.match(styles, /\.admin-sidebar-nav \.sidebar-project-tile\s*\{[\s\S]*?padding: 0 6px 0 18px;/)
})

test('focus mode transitions every menu background through one palette owner', () => {
  const styles = readSource('../src/styles.css')
  const transitionStart = styles.indexOf('/* The value changes happen on the palette scopes')
  const transitionEnd = styles.indexOf('/* Nessie\'s navy navigation.', transitionStart)

  assert.notEqual(transitionStart, -1)
  assert.notEqual(transitionEnd, -1)
  const transitionRule = styles.slice(transitionStart, transitionEnd)
  assert.match(
    transitionRule,
    /\.admin-frame \.phone-navigation-screen aside\[class~='bg-\[color:var\(--sb\)\]'\]/,
  )
  assert.match(
    transitionRule,
    /\.admin-overlay-root aside\[class~='bg-\[color:var\(--sb\)\]'\]/,
  )
  assert.match(transitionRule, /--sb 300ms var\(--easing-standard\)/)
  assert.doesNotMatch(transitionRule, /background-color 300ms/)
  assert.doesNotMatch(transitionRule, /\.sidebar-tree-panel/)
})

test('Channels and Knowledge reuse the sidebar tree presentation primitives', () => {
  const tree = readSource('../src/components/primitives/SidebarTree.tsx')
  const menuSection = readSource('../src/layouts/admin-shell/SidebarMenuSection.tsx')
  const knowledgeTree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')
  const knowledgeSidebar = readSource('../src/components/features/knowledge/finder/FinderTreeSidebar.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(tree, /export const SidebarTreePanel/)
  assert.match(tree, /export const SidebarTreeSectionHeader/)
  assert.match(tree, /export const SidebarTreeChildren/)
  assert.match(menuSection, /SidebarTreeSectionHeader/)
  assert.match(knowledgeSidebar, /SidebarTreePanel/)
  assert.match(knowledgeTree, /SidebarTreeChildren/)
  assert.match(
    styles,
    /\.knowledge-sidebar-tree-panel\s*\{[\s\S]*?flex: 0 0 280px;[\s\S]*?width: 280px;[\s\S]*?overflow-y: auto;/,
  )
  assert.match(styles, /\.knowledge-sidebar-tree-panel \.finder-row\s*\{[\s\S]*?min-height: 30px;/)
  assert.match(styles, /\.knowledge-sidebar-tree-panel \.finder-row\[data-finder-kind='folder'\]/)
  assert.ok(styles.includes('.admin-sidebar-menu.admin-sidebar-menu-channel-project [role="button"]'))
  assert.ok(styles.includes('display: flex;'))
  assert.ok(styles.includes('height: 32px;'))
  assert.ok(styles.includes('padding: 0 10px;'))
  assert.doesNotMatch(styles, /\.knowledge-sidebar-tree-panel[^}]*#[0-9a-fA-F]{3,8}/)
})

test('the Channels project menu uses the 1d icon-row treatment without adding actions', () => {
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const styles = readSource('../src/styles.css')
  const menu = projects.slice(projects.indexOf('admin-sidebar-menu-channel-project'))

  assert.match(menu, /<AddChannelIcon \/>/)
  assert.match(menu, /<EditProjectIcon \/>/)
  assert.match(menu, /aria-label="Add new channel within project"/)
  assert.match(menu, />Add channel to project</)
  assert.match(menu, />Rename &amp; icon</)
  assert.doesNotMatch(menu, /Archive project|Delete project|Move channels/)
  assert.match(
    styles,
    /\.admin-sidebar-menu\.admin-sidebar-menu-channel-project \[role="button"\]/,
  )
})

test('Threads appears directly above Starred in the chat sidebar', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarNav.tsx')

  assert.ok(sidebar.indexOf('sidebar-threads') < sidebar.indexOf('<SidebarStarredSection'))
})

test('a starred direct-message entry is removed from its original sidebar location', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')

  assert.match(source, /starredAgentIds\.has\(personalAssistantAgent\.id\)/)
  assert.match(source, /starredChannelIds\.has\(personalAssistantChannelId\)/)
  assert.match(source, /starredAgentIds\.has\(agent\.id\) \|\| starredChannelIds\.has\(agent\.dmChannelId\)/)
  assert.match(source, /starredChannelIds\.has\(group\.dmChannelId\)/)
  assert.match(source, /starredUserIds\.has\(person\.id\)/)
})

test('group participant labels compact in every sidebar location without consuming the row click', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')
  const channels = readSource('../src/layouts/admin-shell/SidebarChannelsSection.tsx')
  const projects = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')
  const starred = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')
  const label = readSource('../src/layouts/admin-shell/GroupDmSidebarLabel.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(sidebar, /<GroupDmSidebarLabel label=\{group\.label\} \/>/)
  assert.match(channels, /<GroupDmSidebarLabel label=\{channel\.label\} \/>/)
  assert.match(projects, /<GroupDmSidebarLabel label=\{channel\.label\} \/>/)
  assert.match(starred, /<GroupDmSidebarLabel label=\{channel\.label\} \/>/)
  assert.match(label, /new ResizeObserver\(updateWidth\)/)
  assert.match(label, /selectGroupDmSidebarLabel/)
  assert.match(label, /createPortal\(/)
  assert.match(label, /onMouseEnter=\{candidates\.length > 1 && hoverCapable \? showTooltip : undefined\}/)
  // The recipient tooltip is a mouse affordance only: on touch a tap fires
  // mouseenter with no mouseleave, so the handlers must be gated on a
  // hover-capable pointer or the tooltip sticks until an unrelated re-render.
  assert.match(label, /window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/)
  assert.match(label, /role="tooltip"/)
  assert.match(label, /pointer-events-none/)
  assert.match(styles, /\.group-dm-sidebar-tooltip\s*\{[\s\S]*?position: fixed/)
  assert.doesNotMatch(label, /title=\{label\}/)
  assert.doesNotMatch(label, /onClick=/)
})

test('the starred Personal Assistant follows its active direct-message route', () => {
  const source = readSource('../src/layouts/admin-shell/SidebarStarredSection.tsx')

  assert.match(source, /agent\.agentKind === 'personal_assistant'/)
  assert.match(source, /dmChannelId === currentChannelId/)
  assert.match(source, /selectedSessionId \? 'active-parent' : 'active'/)
  assert.match(source, /<SidebarAgentSessions/)
})

test('the Personal Assistant has the same favorite control as a direct-message user', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarDmSection.tsx')
  const assistant = readSource('../src/components/features/personal-assistant/PersonalAssistantSurface.tsx')

  assert.match(sidebar, /onToggleStar\('agent', personalAssistantAgent\.id\)/)
  assert.match(sidebar, /starred=\{Boolean\([\s\S]*?starredAgentIds\.has\(personalAssistantAgent\.id\)/)
  assert.match(assistant, /sidebar-row-star/)
  assert.match(assistant, /\{starred \? '★' : '☆'\}/)
  assert.doesNotMatch(assistant, /sidebar-pa-badge/)
})

test('the Direct-messages Personal Assistant reuses the managed agent avatar record', () => {
  const source = readSource('../src/layouts/admin-shell/useAdminShell.ts')

  assert.match(source, /personalAssistantState\?\.agent/)
  assert.match(source, /\?\? agents\.find\(\(agent\) => agent\.agentKind === 'personal_assistant'\)/)
  assert.match(source, /personalAssistantAgent,\n    personalAssistantBootstrapping/)
})

test('the new-message surface excludes the sender and keeps recipients available after selection', () => {
  const source = readSource('../src/pages/ChannelConversationComposePage.tsx')

  // Step 9: the flow's own 58px bar became the one `ScreenHeader`. Close is
  // a measured action on the split layout; the phone gets the flow's Back.
  assert.match(source, /label: 'Close new message'/)
  assert.match(source, /flowOwnsBack/)
  // The address bar itself is now `components/shared/RecipientBar.tsx`, shared
  // with the board watchers editor. What it must keep doing is asserted there;
  // what the compose screen must keep doing is asserted here.
  const recipientBar = readSource('../src/components/shared/RecipientBar.tsx')
  // Clicking anywhere in the chip row focuses the field and opens the list.
  assert.match(recipientBar, /setFocused\(true\)/)
  // Browser contact/email autofill must not cover the address book.
  assert.match(recipientBar, /autoComplete="off"/)
  // A blur that did not leave the field does not close the list underneath it.
  assert.match(recipientBar, /document\.activeElement !== inputRef\.current/)
  // The compose screen keeps its own handle, because it focuses the field on
  // events the bar knows nothing about — a send with no recipient chosen.
  assert.match(source, /inputRef=\{addressInputRef\}/)
  assert.match(source, /open: !phoneLayout,/)
  assert.match(source, /fixed inset-0 bg-\[color:var\(--main\)\]/)
  // One address book: people and agents together, no People/Agents switch.
  assert.match(source, /placeholder="Search people or agents"/)
  assert.match(source, /agents=\{agents\}/)
  assert.match(source, /users=\{users\}/)
  assert.doesNotMatch(source, /role="tablist"|role="tabpanel"|useTabParam/)
  assert.match(source, /allUsers\.filter\(\(user\) => user\.id !== me\?\.user\.id\)/)
  // Selecting somebody does not close the list: the bar keeps offering whoever
  // is left, which is what makes addressing several people one gesture. Also
  // moved into RecipientBar with the rest of the address bar.
  assert.match(recipientBar, /const showOptions = focused && options\.length > 0/)
  assert.doesNotMatch(source, /\(you\)/)
  assert.match(source, /admin-compose mt-auto flex-shrink-0/)
  assert.match(source, /StartChannelConversation/)
})

test('the compose route retains the channel team and hides mobile navigation chrome', () => {
  const router = readSource('../src/router.tsx')
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  const nativeShell = readSource('../../mobile/App.tsx')

  assert.match(router, /path: '\/channels',\n        element: <ChannelsPage \/>/)
  // Route-level code splitting (05-pages-routing.md F1): the compose screen
  // is lazy-loaded through the shared `lazyElement` Suspense wrapper rather
  // than a static import, so the element is no longer a bare JSX literal.
  assert.match(router, /path: 'new',\n            element: lazyElement\(ChannelConversationComposePage, 'list'\)/)
  assert.match(shell, /mobileLayout && !nativeShell && !isComposeRoute/)
  assert.match(nativeShell, /isFullScreenTaskRoute\(currentPath\)/)
})
