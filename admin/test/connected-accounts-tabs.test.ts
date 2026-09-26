import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  CONNECTION_TABS,
  CONNECTION_TAB_META,
  DEFAULT_CONNECTION_TAB,
  PROVIDER_TAB,
  connectedAccountsPath,
  tabForProvider,
} from '../src/pages/settings/connections/connection-tabs'
import { landingMessage } from '../src/pages/settings/connections/useConnectionLanding'

// Connected accounts groups a person's accounts by what they are for, in five
// tabs addressed by `?tab=`. A synced account is listed on its provider's tab
// and its page returns there, and a provider's sign-in comes back with a
// notice that lands on that same tab.

test('five tabs, in the order people reach for them', () => {
  assert.deepEqual([...CONNECTION_TABS], ['mail', 'chat', 'tickets', 'browsers', 'ai'])
  assert.deepEqual(
    CONNECTION_TABS.map((tab) => CONNECTION_TAB_META[tab].label),
    ['Mail and calendar', 'Chat', 'Tickets and code', 'Browsers', 'AI plans'],
  )
  assert.equal(DEFAULT_CONNECTION_TAB, 'mail')
})

test('each tab says what a person does there in one sentence, naming no protocol', () => {
  for (const tab of CONNECTION_TABS) {
    const { description } = CONNECTION_TAB_META[tab]
    assert.match(description, /^[A-Z][^.]*\.$/, `${tab}: one sentence`)
    assert.doesNotMatch(description, /\b(?:IMAP|SMTP|OAuth|API|APIs|MCP|Browserbase)\b/i, `${tab}: no protocol`)
  }
})

test('a synced account is listed on, and returns to, its provider’s tab', () => {
  assert.deepEqual(PROVIDER_TAB, { google: 'mail', microsoft: 'mail', slack: 'chat' })
  assert.equal(connectedAccountsPath(PROVIDER_TAB.slack), '/settings/accounts?tab=chat')
  assert.equal(connectedAccountsPath(PROVIDER_TAB.google), '/settings/accounts')
  assert.equal(connectedAccountsPath('ai'), '/settings/accounts?tab=ai')
})

test('an OAuth return names a tab only through a provider this admin knows', () => {
  assert.equal(tabForProvider('slack'), 'chat')
  assert.equal(tabForProvider('google'), 'mail')
  assert.equal(tabForProvider('microsoft'), 'mail')
  assert.equal(tabForProvider(null), null)
  assert.equal(tabForProvider('jira'), null)
  assert.equal(tabForProvider('toString'), null)
})

test('the return’s notice copy', () => {
  assert.equal(landingMessage('slack', null), 'Slack connected.')
  assert.equal(landingMessage('google', null), 'Email connected.')
  assert.equal(
    landingMessage(null, 'state_invalid'),
    'That connection link has expired. Start again to continue.',
  )
  assert.equal(landingMessage(null, 'unknown_provider'), 'Connection was not completed. Try again.')
  assert.equal(landingMessage(null, null), null)
})

type Landed = {
  afterBack: string
  notice: { message: string; tab: string | null } | null
  search: string
  tab: string
}

// The page's own pair — `useTabParam` over the five tabs and the landing hook
// — mounted on a memory router at an OAuth return, then walked Back.
const landOn = async (entry: string): Promise<Landed> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  try {
    const React = await import('react')
    const { act, createElement: h } = React
    const { createRoot } = await import('react-dom/client')
    const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
    const { useTrackLocationKey } = await import('../src/navigation/redirect')
    const { useTabParam } = await import('../src/navigation/useTabParam')
    const { useConnectionLanding } = await import('../src/pages/settings/connections/useConnectionLanding')

    const Probe = () => {
      useTrackLocationKey()
      const [tab, selectTab] = useTabParam('tab', CONNECTION_TABS, DEFAULT_CONNECTION_TAB)
      const { notice } = useConnectionLanding(tab, selectTab)
      return h('p', null, JSON.stringify({ notice, tab }))
    }
    const router = createMemoryRouter([
      { path: '/before', element: h('p', null, 'Before') },
      { path: '/settings/accounts', element: h(Probe) },
    ], { initialEntries: ['/before', entry], initialIndex: 1 })
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const settle = async () => {
      for (let turn = 0; turn < 6; turn += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      }
    }
    try {
      await act(async () => root.render(h(RouterProvider, { router })))
      await settle()
      const rendered = JSON.parse(container.textContent ?? '{}') as Pick<Landed, 'notice' | 'tab'>
      const search = router.state.location.search
      await act(async () => { await router.navigate(-1) })
      return { ...rendered, afterBack: router.state.location.pathname, search }
    } finally {
      await act(async () => root.unmount())
    }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

test('Slack’s return lands on Chat with its notice, and leaves no entry behind', async () => {
  const landed = await landOn('/settings/accounts?connected=slack')
  assert.equal(landed.search, '?tab=chat')
  assert.equal(landed.tab, 'chat')
  assert.deepEqual(landed.notice, { message: 'Slack connected.', tab: 'chat' })
  // The strip and the tab both replaced the landing entry: Back leaves.
  assert.equal(landed.afterBack, '/before')
})

test('a Google refusal lands on Mail and calendar, the bare address', async () => {
  const landed = await landOn('/settings/accounts?error=state_invalid&provider=google')
  assert.equal(landed.search, '')
  assert.equal(landed.tab, 'mail')
  assert.deepEqual(landed.notice, {
    message: 'That connection link has expired. Start again to continue.',
    tab: 'mail',
  })
})

test('the provider’s tab wins over a tab the return happened to carry', async () => {
  const landed = await landOn('/settings/accounts?tab=ai&error=access_denied&provider=slack')
  assert.equal(landed.search, '?tab=chat')
  assert.deepEqual(landed.notice, { message: 'Connection was not completed.', tab: 'chat' })
})

test('a return naming no known provider stays on its tab and shows on any', async () => {
  const landed = await landOn('/settings/accounts?tab=ai&error=unknown_provider')
  assert.equal(landed.search, '?tab=ai')
  assert.equal(landed.tab, 'ai')
  assert.deepEqual(landed.notice, { message: 'Connection was not completed. Try again.', tab: null })
})

test('an ordinary visit carries no notice and writes nothing', async () => {
  const landed = await landOn('/settings/accounts?tab=tickets')
  assert.equal(landed.search, '?tab=tickets')
  assert.equal(landed.tab, 'tickets')
  assert.equal(landed.notice, null)
})
