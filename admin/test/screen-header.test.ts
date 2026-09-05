import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { LocalBackProvider } from '../src/layouts/admin-shell/local-back/LocalBackContext.js'
import { ShellStateProvider } from '../src/layouts/admin-shell/ShellStateContext.js'
import { PhoneNavigationProvider } from '../src/layouts/admin-shell/PhoneNavigationProvider.js'
import { ScreenHeader } from '../src/components/shared/ScreenHeader.js'
import { ColumnBrowserColumn } from '../src/components/shared/column-browser/ColumnBrowserColumn.js'
import {
  applyScreen,
  describeScreen,
  publishScreenTitle,
  resetScreenTitles,
  sameScreen,
  screenDocumentTitle,
  screenTitleFor,
} from '../src/navigation/screen.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = `${directory}/${entry.name}`
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [full] : []
  })

// The header always renders on the single-column layout: a test process has
// no window (or a jsdom whose matchMedia answers false), so the viewport
// store reports `narrow` and `deriveNavigationLayout` returns 'single' —
// which is the interesting case, because that is where the shared doorway
// paints.
const renderHeader = (
  pathname: string,
  props: Parameters<typeof ScreenHeader>[0],
): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      createElement(
        LocalBackProvider,
        null,
        createElement(
          ShellStateProvider,
          {
            value: {
              onCreateAgent: () => {},
              onCreateChannel: () => {},
              onLogout: () => {},
              onSelectAgent: () => {},
              openDrawer: () => {},
              showHeaderAccountMenu: false,
            },
          },
          createElement(
            PhoneNavigationProvider,
            null,
            createElement(ScreenHeader, props),
          ),
        ),
      ),
    ),
  )

test('a screen header renders exactly one h1, and it carries the title', () => {
  resetScreenTitles()
  const markup = renderHeader('/threads', { title: 'Threads' })
  assert.equal(markup.match(/<h1[\s>]/g)?.length, 1, 'exactly one h1 per screen')
  assert.doesNotMatch(markup, /<h2[\s>]/, 'the screen title is never demoted to h2')
  assert.match(markup, /<h1[^>]*>Threads<\/h1>/)
})

test('the leading lane is the shared Back doorway where the screen has a parent, and the menu at a root', () => {
  resetScreenTitles()
  // `/threads` is a Channels detail (parent: Channels), so the one Back
  // resolver answers with a route Back and the doorway paints it.
  const detail = renderHeader('/threads', { title: 'Threads' })
  assert.match(detail, /aria-label="Back to Channels"/)
  assert.doesNotMatch(detail, /aria-label="Open navigation"/)

  // `/channels` is the section root: Back has nowhere to go, so the same
  // doorway paints the menu instead.
  const root = renderHeader('/channels', { title: 'Channels' })
  assert.match(root, /aria-label="Open navigation"/)
  assert.doesNotMatch(root, /aria-label="Back to/)
})

test('the subtitle and tabs slots are optional, and render inside the one header', () => {
  resetScreenTitles()
  const bare = renderHeader('/threads', { title: 'Threads' })
  assert.doesNotMatch(bare, /data-testid="screen-subtitle"/)

  const withSlots = renderHeader('/threads', {
    subtitle: createElement('p', { 'data-testid': 'screen-subtitle' }, 'Everything you follow'),
    tabs: createElement('div', { 'data-testid': 'screen-tabs' }, 'All'),
    title: 'Threads',
  })
  assert.match(withSlots, /data-testid="screen-subtitle"/)
  assert.match(withSlots, /data-testid="screen-tabs"/)
  // One header element, with the slots inside it — never a second bar under it.
  assert.equal(withSlots.match(/<header[\s>]/g)?.length, 1)
  const subtitleAt = withSlots.indexOf('data-testid="screen-subtitle"')
  assert.ok(subtitleAt > 0 && subtitleAt < withSlots.lastIndexOf('</header>'))
})

test('the header publishes its title under its own route, and the shell reads it back', () => {
  resetScreenTitles()
  assert.equal(screenTitleFor('/threads'), '')
  publishScreenTitle('/threads', 'Threads')
  assert.equal(screenTitleFor('/threads'), 'Threads')
  // Query and trailing slash are not a different screen.
  assert.equal(screenTitleFor('/threads/?filter=mine'), 'Threads')
  assert.equal(screenTitleFor('/channels'), '', 'a title never leaks onto another route')
})

test('document.title follows the header title', () => {
  const dom = new JSDOM('<!doctype html><html><head><title>Nessie Admin</title></head><body></body></html>')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  try {
    applyScreen(describeScreen('/threads', 'Threads', true), null)
    assert.equal(dom.window.document.title, 'Threads · Nessie')

    applyScreen(describeScreen('/channels/chan_1', 'Design review', true), null)
    assert.equal(dom.window.document.title, 'Design review · Nessie')

    // A screen whose header has not published yet keeps the product name
    // alone rather than rendering a leading separator.
    applyScreen(describeScreen('/channels', '', false), null)
    assert.equal(dom.window.document.title, 'Nessie')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  assert.equal(screenDocumentTitle('  Apps  '), 'Apps · Nessie')
})

test('the bridge posts nessie:screen with its six fields off the registry, the resolver and the header', () => {
  const dom = new JSDOM('<!doctype html><html><head><title>x</title></head><body></body></html>')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const posted: string[] = []
  try {
    applyScreen(describeScreen('/agents/agent_1', 'Ada', true), (payload) => posted.push(payload))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }

  assert.equal(posted.length, 1)
  assert.deepEqual(JSON.parse(posted[0] as string), {
    depth: 2,
    hasBack: true,
    path: '/agents/agent_1',
    screenType: 'detail',
    section: 'admin',
    title: 'Ada',
    // The page type is `screenType`; `type` stays the bridge's own message
    // discriminant, which is what the native shell switches on.
    type: 'nessie:screen',
  })

  // Every field of the message is compared, so a settled change of any one of
  // them posts and a re-render that changes none of them does not.
  const screen = describeScreen('/agents/agent_1', 'Ada', true)
  assert.equal(sameScreen(screen, describeScreen('/agents/agent_1', 'Ada', true)), true)
  for (const changed of [
    describeScreen('/agents/agent_2', 'Ada', true),
    describeScreen('/agents/agent_1', 'Grace', true),
    describeScreen('/agents/agent_1', 'Ada', false),
    describeScreen('/agents', 'Agents', true),
  ]) {
    assert.equal(sameScreen(screen, changed), false)
  }
  assert.equal(sameScreen(null, screen), false)

  const bridge = readSource('../src/layouts/admin-shell/NativePhoneNavigationBridge.tsx')
  assert.match(bridge, /describeScreen\(location\.pathname, screenTitle, hasBack\)/)
  assert.match(bridge, /applyScreen\(screen, isReactNativeWebView\(\)/)
  assert.match(bridge, /if \(sameScreen\(postedScreen\.current, screen\)\) return/)
  // The two existing bridge messages are untouched beside it.
  assert.match(bridge, /type: 'nessie:back-state'/)
  const shellBridge = readSource('../src/providers/NativeShellBridge.tsx')
  assert.match(shellBridge, /type: 'nessie:route'/)
})

/**
 * Every remaining `<header>` outside `ScreenHeader`/`ResponsivePageHeader`
 * that is not a route's own screen, and why it is not one — a card's own
 * heading row, an overlay panel's bar, persistent shell chrome (08-F2/F3: a
 * second screen-header shape reappeared one layer down, in
 * `components/shared/column-browser` and `components/features/channels`,
 * exactly where this gate's old `pages/**`-only walk could not see it).
 * Self-checking below, so this list only ever shrinks
 * (docs/navigation/deep-links-and-headers.md §9).
 */
const HAND_ROLLED_HEADER_ALLOWLIST = new Map<string, string>([
  ['components/shared/ResponsivePageHeader.tsx', 'the one sanctioned <header> element ScreenHeader composes'],
  ['components/features/settings/AutomaticMembershipDomainRow.tsx', "a roster row's own header grouping a domain and its status pill, not a screen"],
  ['components/features/browser-cloud/AgentScreenPanel.tsx', "the agent-screen side panel's own h2 bar (an overlay panel, not a route screen)"],
  ['components/features/projects/DashboardSectionCard.tsx', "a dashboard card's own header row (h2 SectionLabel), sectioning content inside the card"],
  ['components/features/agents/AgentDetailDrawer.tsx', "a drawer's own header row; the drawer is an overlay, not a route screen"],
  ['components/features/dashboards/DashboardWorkspacePanel.tsx', "the dashboard workspace side panel's own h2 bar (an overlay panel, not a route screen)"],
  ['components/features/dashboards/WidgetFrame.tsx', "a widget's own title row (h3), sectioning content inside the card"],
  ['components/features/channels/ThoughtProcessDialog.tsx', "a dialog's own header row; the dialog is an overlay, not a route screen"],
  ['components/features/channels/AgentCardMessage.tsx', "a chat message card's own header row, sectioning content inside the bubble"],
  ['components/features/channels/DocumentStreamDialog.tsx', "a dialog's own header row (h2); the dialog is an overlay, not a route screen"],
  ['components/features/channels/ChannelUserInfoDrawer.tsx', "a drawer's own header row; the drawer is an overlay, not a route screen"],
  ['components/features/channels/thread-panel/ThreadReplyPanel.tsx', "the reply-thread side panel's own header row (the §4 overlay carve-out), not a route screen"],
  ['components/features/channels/ChannelAgentInfoDrawer.tsx', "two drawer header rows; the drawer is an overlay, not a route screen"],
  ['components/shared/AttachmentViewer.tsx', "a dialog's own header row (h2); the dialog is an overlay, not a route screen"],
  ['layouts/admin-shell/TopBar.tsx', "the desktop shell's persistent top bar, chrome above every route rather than a screen"],
  ['layouts/admin-shell/MobileWebHomeHeader.tsx', "the mobile web root's own chrome header, not a route screen"],
])

test('every page header in admin/src is the one ScreenHeader', () => {
  // `AdminPageHeader` and `MobileSectionHeader` are gone, not deprecated: a
  // second header shape is the defect Rule zero names.
  assert.equal(existsSync(`${srcDir}/components/shared/AdminPageHeader.tsx`), false)
  assert.equal(existsSync(`${srcDir}/layouts/admin-shell/MobileSectionHeader.tsx`), false)
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8')
    // Neither is imported nor rendered anywhere. (`ScreenHeader`'s own doc
    // comment names both, because saying what it replaced is the point.)
    assert.doesNotMatch(
      source,
      /<(AdminPageHeader|MobileSectionHeader)[\s/>]|from '[^']*\/(AdminPageHeader|MobileSectionHeader)'/,
      `${file} still uses a retired header`,
    )
  }

  // No file paints its own `<header>` element any more unless the allowlist
  // above names it and says why — widened from `pages/**` to all of
  // `admin/src`, since the defect this test exists to catch (a hand-rolled
  // header the §9 gate cannot see) reappeared one layer down, not inside a
  // page file.
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('<header')) continue
    const relative = file.slice(srcDir.length + 1)
    assert.ok(
      HAND_ROLLED_HEADER_ALLOWLIST.has(relative),
      `${file} renders a hand-rolled <header> not in HAND_ROLLED_HEADER_ALLOWLIST`,
    )
  }
  for (const relative of HAND_ROLLED_HEADER_ALLOWLIST.keys()) {
    const source = readFileSync(`${srcDir}/${relative}`, 'utf8')
    assert.ok(
      source.includes('<header'),
      `${relative} no longer renders <header> — shrink HAND_ROLLED_HEADER_ALLOWLIST`,
    )
  }

  // And the pages that own a screen title render it through the one header.
  const pages = walk(`${srcDir}/pages`)
  assert.ok(pages.length > 20, 'the page tree was found')
  const headerPages = pages.filter((file) => /<ScreenHeader/.test(readFileSync(file, 'utf8')))
  assert.ok(headerPages.length >= 18, `expected the converted pages, found ${headerPages.length}`)
})

test('a column-browser screen column renders exactly one h1, and a section column keeps its h3', () => {
  // 08-F2/05-F2: the four column-browser routes (Tools, Triggers, Workflows,
  // Integrations) render their real screen through `ColumnBrowserColumn`'s
  // `screen` column rather than through a page-level `<ScreenHeader>` call —
  // this pins the shared primitive's two shapes directly, since none of
  // those four page files literally write `<ScreenHeader`.
  resetScreenTitles()
  const renderColumn = (props: Parameters<typeof ColumnBrowserColumn>[0]): string =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/agents/tools'] },
        createElement(
          LocalBackProvider,
          null,
          createElement(
            ShellStateProvider,
            {
              value: {
                onCreateAgent: () => {},
                onCreateChannel: () => {},
                onLogout: () => {},
                onSelectAgent: () => {},
                openDrawer: () => {},
                showHeaderAccountMenu: false,
              },
            },
            createElement(
              PhoneNavigationProvider,
              null,
              createElement(ColumnBrowserColumn, props),
            ),
          ),
        ),
      ),
    )

  const screen = renderColumn({
    children: createElement('p', null, 'body'),
    screen: true,
    title: 'Tools (3)',
  })
  assert.equal(screen.match(/<h1[\s>]/g)?.length, 1, 'exactly one h1 for the screen column')
  assert.doesNotMatch(screen, /<h3[\s>]/, 'the screen column does not also paint the section bar')

  const section = renderColumn({
    children: createElement('p', null, 'body'),
    onBack: () => {},
    showBack: true,
    title: 'Detail',
  })
  assert.doesNotMatch(section, /<h1[\s>]/, 'a deeper column is sectioning content, not the screen')
  assert.equal(section.match(/<h3[\s>]/g)?.length, 1)
})

test('ScreenHeader composes the measured partition rather than forking it', () => {
  const header = readSource('../src/components/shared/ScreenHeader.tsx')
  assert.match(header, /<ResponsivePageHeader/)
  assert.match(header, /publishScreenTitle\(pathname, title\)/)
  assert.match(header, /retireScreenTitle\(pathname, title\)/)
  // The leading lane: the shared doorway on `single`, the page's Back on a
  // wide layout and only where the registry says the screen has a parent.
  assert.match(header, /surfaceParent\(pathname\) !== null/)
  assert.match(header, /<PhoneNavigationButton \/>/)
  // The measurement itself stays in ResponsivePageHeader.
  assert.doesNotMatch(header, /getBoundingClientRect/)
  assert.doesNotMatch(header, /ResizeObserver/)
})
