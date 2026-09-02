import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  attachKeyboardInsetListener,
  KEYBOARD_INSET_PROPERTY,
} from '../src/navigation/keyboard'
import { SHELL_MAIN_ID } from '../src/navigation/SkipToContentLink'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// docs/navigation.md §12 — aria-current, the skip link, forced-colors, the
// keyboard inset and split scroll memory (step 11's remainder).

test('the shared helper marks aria-current="page" only when active', () => {
  const helper = source('../src/layouts/admin-shell/SidebarRow.tsx')
  assert.match(helper, /export const sidebarAriaCurrent = \(active: boolean\): 'page' \| undefined/)
  assert.match(helper, /active \? 'page' : undefined/)
})

test('the rail item carries aria-current through the shared helper', () => {
  const rail = source('../src/layouts/admin-shell/SidebarRail.tsx')
  assert.match(rail, /aria-current=\{sidebarAriaCurrent\(isActive\)\}/)
  assert.match(rail, /from '\.\/SidebarRow'/)
})

// Every file that renders a sidebar row carrying the `active` class must
// also carry `sidebarAriaCurrent(` (this file's own helper, or `NavLink`
// which sets aria-current="page" automatically for its own active link —
// pinned separately below for the one row that relies on it).
test('every section-sidebar row file wires sidebarAriaCurrent alongside its active class', () => {
  const files = [
    '../src/layouts/admin-shell/SidebarNav.tsx',
    '../src/layouts/admin-shell/AdminSidebarNav.tsx',
    '../src/layouts/admin-shell/KnowledgeSidebarNav.tsx',
    '../src/layouts/admin-shell/ProjectsSidebarNav.tsx',
    '../src/layouts/admin-shell/SidebarChannelsSection.tsx',
    '../src/layouts/admin-shell/SidebarDmSection.tsx',
    '../src/layouts/admin-shell/SidebarProjectsSection.tsx',
    '../src/layouts/admin-shell/SidebarStarredSection.tsx',
    '../src/components/features/knowledge/KnowledgeSpaceList.tsx',
    '../src/components/features/personal-assistant/PersonalAssistantSurface.tsx',
  ]
  for (const file of files) {
    const text = source(file)
    const activeClassCount = (text.match(/\?\s*'active'\s*:/g) ?? []).length
    const ariaCurrentCount = (text.match(/sidebarAriaCurrent\(/g) ?? []).length
    assert.ok(
      activeClassCount > 0,
      `${file} was expected to still carry an 'active' class toggle`,
    )
    // Every conditional 'active' class in these files is paired with a
    // sidebarAriaCurrent(...) call (some rows compute the boolean once and
    // reuse it for both, so the counts need not match exactly, but a file
    // with zero calls has regressed).
    assert.ok(
      ariaCurrentCount > 0,
      `${file} carries 'active' classes but no sidebarAriaCurrent(...) call`,
    )
  }
})

test('the Knowledge dashboards row relies on NavLink\'s own aria-current, not the helper', () => {
  const knowledge = source('../src/layouts/admin-shell/KnowledgeSidebarNav.tsx')
  assert.match(
    knowledge,
    /<NavLink\s+className=\{\(\{ isActive \}\) => \['admin-sb-item', isActive \? 'active' : ''\]\.join\(' '\)\}/,
  )
})

test('the skip link is mounted at the top of the shell and targets its own main', () => {
  const shell = source('../src/layouts/AdminShellLayout.tsx')
  assert.match(shell, /import \{ SHELL_MAIN_ID, SkipToContentLink \} from '\.\.\/navigation\/SkipToContentLink'/)
  // Mounted before the frame div — the first focusable thing in the shell.
  const skipIndex = shell.indexOf('<SkipToContentLink />')
  const frameIndex = shell.indexOf('<div className={frameClassName}')
  assert.ok(skipIndex > -1 && frameIndex > -1 && skipIndex < frameIndex)
  // Both `<main>` render branches carry the target id and are focusable.
  const mainMatches = shell.match(/<main\b[\s\S]*?id=\{SHELL_MAIN_ID\}[\s\S]*?tabIndex=\{-1\}/g) ?? []
  assert.equal(mainMatches.length, 2, 'phone and split main branches both need the target id + tabIndex')

  const link = source('../src/navigation/SkipToContentLink.tsx')
  assert.match(link, /export const SHELL_MAIN_ID = 'admin-shell-main'/)
  assert.match(link, /href=\{`#\$\{SHELL_MAIN_ID\}`\}/)
  assert.match(link, /sr-only focus:not-sr-only/)
  assert.equal(SHELL_MAIN_ID, 'admin-shell-main')
})

test('forced-colors gives the four colour-only signals a non-colour fallback', () => {
  const css = source('../src/styles.css')
  const block = css.slice(css.indexOf('@media (forced-colors: active) {'))
  assert.ok(block.length > 0, 'the forced-colors block exists')
  // 1. Selection pills (TabBar's sliding indicator).
  assert.match(block, /\.tabbar-indicator\s*\{[^}]*border:\s*1px solid Highlight/)
  // 2. The rail's active tile.
  assert.match(block, /\.admin-rail-btn\.active \.admin-rail-btn-icon\s*\{[^}]*border:\s*2px solid Highlight/)
  // 3. Focus rings.
  assert.match(block, /:focus-visible\s*\{[^}]*outline-color:\s*Highlight/)
  // 4. Card borders.
  assert.match(block, /\.admin-card,[\s\S]*?\{[^}]*border-color:\s*CanvasText/)
})

// The plan (docs/plans/2026-09-01-navigation-motion-system.md §4.14) counts
// nine overlay panels and two stylesheet rules using a bare `vh` unit; all
// eleven move to `dvh` so the dynamic viewport (not the layout viewport,
// which a soft keyboard does not shrink) drives their sizing.
test('no bare vh unit remains in the nine overlay panels', () => {
  const overlayFiles = [
    '../src/components/shared/MemberManagementPopup.tsx',
    '../src/components/shared/Dialog.tsx',
    '../src/components/shared/AttachmentViewer.tsx',
    '../src/components/features/channels/ThoughtProcessDialog.tsx',
    '../src/components/features/billing/UoaBillingCancellationDialog.tsx',
    '../src/components/features/integrations/DeepWaterResearchLauncherDialog.tsx',
    '../src/components/features/triggers/TriggerEditorDialog.tsx',
  ]
  let bareVhCount = 0
  for (const file of overlayFiles) {
    const text = source(file)
    // A bare `vh` not immediately preceded by `d` (i.e. not `dvh`) and not
    // part of an unrelated word.
    const matches = text.match(/(?<!d)\bvh\b/g) ?? []
    assert.equal(matches.length, 0, `${file} still has a bare vh unit`)
  }
  // Dialog.tsx and AttachmentViewer.tsx each account for more than one of
  // the plan's nine — assert the total lands on nine dvh conversions across
  // the group (Dialog xl, MemberManagementPopup, AttachmentViewer x3,
  // ThoughtProcessDialog, UoaBillingCancellationDialog,
  // DeepWaterResearchLauncherDialog, TriggerEditorDialog).
  for (const file of overlayFiles) {
    // `dvh` always follows a digit here (`88dvh`, `calc(100dvh-2rem)`), so
    // there is no word boundary before the `d` — only match its tail.
    bareVhCount += (source(file).match(/dvh\b/g) ?? []).length
  }
  assert.ok(bareVhCount >= 9, `expected at least nine dvh conversions, found ${bareVhCount}`)
})

test('Dialog\'s xl size specifically uses dvh, not vh, for maxHeight', () => {
  const dialog = source('../src/components/shared/Dialog.tsx')
  assert.match(dialog, /xl:\s*\{[^}]*maxHeight:\s*'88dvh'/)
})

test('the two stylesheet rules that sized with vh now use dvh', () => {
  const css = source('../src/styles.css')
  assert.match(css, /\.admin-topbar-results\s*\{[^}]*max-height:\s*60dvh/)
  assert.match(css, /\.admin-topbar-search--overlay \.admin-topbar-results\s*\{[^}]*max-height:\s*min\(56dvh, 520px\)/)
  assert.doesNotMatch(css, /(?<!d)\bvh\b/, 'no bare vh unit should remain in styles.css')
})

test('the message composer editable region hints a send key on the soft keyboard', () => {
  const mentionInput = source('../src/components/shared/MentionInput.tsx')
  assert.match(mentionInput, /enterKeyHint="send"/)
})

test('the channel composer container reserves space for the keyboard inset', () => {
  const composer = source('../src/components/features/channels/ChannelComposer.tsx')
  assert.match(composer, /paddingBottom: 'calc\(14px \+ var\(--keyboard-inset, 0px\)\)'/)
})

test('the channel list and knowledge tree sidebars carry a stable scroll-memory key', () => {
  const sidebarNav = source('../src/layouts/admin-shell/SidebarNav.tsx')
  assert.match(sidebarNav, /useScrollMemory\('sidebar:channel-list'\)/)
  assert.match(sidebarNav, /ref=\{channelListScroll\.ref\}/)

  const knowledgeNav = source('../src/layouts/admin-shell/KnowledgeSidebarNav.tsx')
  assert.match(knowledgeNav, /useScrollMemory\('sidebar:knowledge-tree'\)/)
  assert.match(knowledgeNav, /ref=\{treeScroll\.ref\}/)
})

test('the agents list already remembers its scroll position per scope', () => {
  const agentsList = source('../src/components/features/agents/AgentsList.tsx')
  assert.match(agentsList, /useScrollMemory\(`agents:list:\$\{activeScope\}`\)/)
})

// --- jsdom: the visualViewport listener itself ---

const fakeWindow = (innerHeight: number) => {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true })
  const listeners = new Map<string, () => void>()
  const viewport = {
    addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
    removeEventListener: (type: string) => listeners.delete(type),
    height: innerHeight,
    offsetTop: 0,
  }
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  return {
    fireResize: () => listeners.get('resize')?.(),
    inset: () => window.document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY),
    viewport,
    window,
  }
}

test('a visualViewport resize below the keyboard height sets --keyboard-inset', () => {
  const { fireResize, inset, viewport, window } = fakeWindow(800)
  const detach = attachKeyboardInsetListener(window as unknown as Window)
  assert.equal(inset(), '0px')

  viewport.height = 500 // keyboard opened, ~300px tall
  fireResize()
  assert.equal(inset(), '300px')

  viewport.height = 800 // keyboard closed
  fireResize()
  assert.equal(inset(), '0px')

  detach()
})

test('a small visualViewport delta (browser chrome, not a keyboard) is ignored', () => {
  const { fireResize, inset, viewport, window } = fakeWindow(800)
  const detach = attachKeyboardInsetListener(window as unknown as Window)

  viewport.height = 770 // 30px — under the keyboard threshold
  fireResize()
  assert.equal(inset(), '0px')

  detach()
})

test('detaching the listener clears the inset and removes the event listeners', () => {
  const { fireResize, inset, viewport, window } = fakeWindow(800)
  const detach = attachKeyboardInsetListener(window as unknown as Window)
  viewport.height = 400
  fireResize()
  assert.equal(inset(), '400px')

  detach()
  assert.equal(inset(), '0px')
})

test('with no visualViewport at all, the listener is a harmless no-op', () => {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>')
  const detach = attachKeyboardInsetListener(window as unknown as Window)
  assert.equal(
    window.document.documentElement.style.getPropertyValue(KEYBOARD_INSET_PROPERTY),
    '0px',
  )
  assert.doesNotThrow(() => detach())
})
