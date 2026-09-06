import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import type { MeResponse } from '@nessie/schemas'

/**
 * The one super-admin refusal and the one super-admin derivation, mirroring
 * `owner-gate.test.ts` one tier up (05-pages-routing.md F6): `OpsHealthPage`
 * used to ask `me?.user.superAdmin ?? false` inline and return its refusal
 * *before* `<ScreenHeader>`, which is exactly the "five states returned
 * before any header" defect class §9 already fixed once for `OwnerGate`.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5455/ops',
})

const React = await import('react')
const { createElement } = React
const { renderToStaticMarkup } = await import('react-dom/server')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter } = await import('react-router-dom')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { ApiClientProvider } = await import('../src/providers/ApiClientProvider.js')
const { LocalBackProvider } = await import('../src/navigation/LocalBackContext.js')
const { ShellStateProvider } = await import('../src/layouts/admin-shell/ShellStateContext.js')
const { PhoneNavigationProvider } = await import('../src/layouts/admin-shell/PhoneNavigationProvider.js')
const { SuperAdminGate, isSuperAdminSession } = await import('../src/components/shared/SuperAdminGate.js')
const { OpsHealthPage } = await import('../src/pages/OpsHealthPage.js')

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const session = (superAdmin: boolean): MeResponse =>
  ({ user: { roleIds: [], superAdmin } }) as unknown as MeResponse

test('super-admin is a session flag — nothing else counts', () => {
  assert.equal(isSuperAdminSession(session(true)), true)
  assert.equal(isSuperAdminSession(session(false)), false)
})

test('no session is not a super-admin', () => {
  assert.equal(isSuperAdminSession(null), false)
})

const withLocalStorage = <T,>(run: () => T): T => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
    writable: true,
  })
  try {
    return run()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

const renderGate = (): string => withLocalStorage(() => renderToStaticMarkup(
  createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(
      AuthSessionProvider,
      null,
      createElement(SuperAdminGate, null, createElement('p', null, 'the super-admin-only page')),
    ),
  ),
))

test('a non-super-admin gets the refusal OpsHealthPage used to spell out inline', () => {
  assert.equal(
    renderGate(),
    '<section class="flex h-full items-center justify-center text-[color:var(--tx3)]">'
    + 'Instance super-admin access required</section>',
  )
})

test('the gated content is not rendered for a non-super-admin', () => {
  assert.doesNotMatch(renderGate(), /the super-admin-only page/)
})

const shellStateValue = {
  onCreateAgent: () => {},
  onCreateChannel: () => {},
  onLogout: () => {},
  onSelectAgent: () => {},
  openDrawer: () => {},
  showHeaderAccountMenu: false,
}

const renderOpsHealthPage = (): string => withLocalStorage(() => renderToStaticMarkup(
  createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(
      MemoryRouter,
      { initialEntries: ['/ops'] },
      createElement(
        AuthSessionProvider,
        null,
        createElement(
          ApiClientProvider,
          null,
          createElement(
            LocalBackProvider,
            null,
            createElement(
              ShellStateProvider,
              { value: shellStateValue },
              createElement(
                PhoneNavigationProvider,
                null,
                createElement(OpsHealthPage),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
))

test('OpsHealthPage renders its header before the refusal, with exactly one h1 (05-F3)', () => {
  const markup = renderOpsHealthPage()
  assert.equal(markup.match(/<h1[\s>]/g)?.length, 1, 'exactly one h1, even on the refusal branch')
  assert.match(markup, /<h1[^>]*>System Health<\/h1>/)
  assert.match(markup, /Instance super-admin access required/)
})
