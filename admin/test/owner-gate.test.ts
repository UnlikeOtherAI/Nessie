import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import type { MeResponse } from '@nessie/schemas'

/**
 * The one owner refusal and the one owner derivation.
 *
 * Five owner-only pages rendered the same sentence in byte-identical markup
 * and 26 call sites re-derived `roleIds.includes('owner')`. Both halves now
 * come from `OwnerGate.tsx`, so the two tests below pin the two halves: the
 * derivation's truth table, and the sentence the gate actually renders when
 * the session it reads is not an owner's.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:5455/audit',
})

const React = await import('react')
const { createElement } = React
const { renderToStaticMarkup } = await import('react-dom/server')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { OwnerGate, isOwnerSession } = await import('../src/components/shared/OwnerGate.js')

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const session = (roleIds: string[]): MeResponse =>
  ({ user: { roleIds } }) as unknown as MeResponse

test('owner is a role the session carries — nothing else counts', () => {
  assert.equal(isOwnerSession(session(['owner'])), true)
  // Real sessions carry several roles; owner among them is still owner.
  assert.equal(isOwnerSession(session(['member', 'admin', 'owner'])), true)
  assert.equal(isOwnerSession(session(['admin'])), false)
  assert.equal(isOwnerSession(session([])), false)
})

// The `?? false` every one of the 26 call sites carried: a page can render
// before the session resolves, and "not loaded yet" is not "owner".
test('no session is not an owner', () => {
  assert.equal(isOwnerSession(null), false)
})

/**
 * Renders the gate against the real `AuthSessionProvider`, which starts with
 * no session — the non-owner case. The provider reads `localStorage` in a
 * state initialiser, so the global is installed for the render and removed
 * again: every file in this package's suite shares one process
 * (`--experimental-test-isolation=none`).
 */
const renderGate = (): string => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
    writable: true,
  })
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          AuthSessionProvider,
          null,
          createElement(OwnerGate, null, createElement('p', null, 'the owner-only page')),
        ),
      ),
    )
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('a non-owner gets the refusal the five pages used to spell out each', () => {
  assert.equal(
    renderGate(),
    '<section class="flex h-full items-center justify-center text-[color:var(--tx3)]">'
    + 'Owner access required</section>',
  )
})

// The gate withholds the page, not just the chrome around it: a non-owner must
// not get the owner-only body rendered underneath a refusal.
test('the gated content is not rendered for a non-owner', () => {
  assert.doesNotMatch(renderGate(), /the owner-only page/)
})
