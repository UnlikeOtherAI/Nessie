import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import {
  invitationSentToast,
  joinNames,
  memberAddedToast,
} from '../src/components/features/settings/member-roster-feedback.js'
import { stubResizeObserver } from './support/resize-observer-stub'

/**
 * Sending an invitation used to close the dialog without a word: the only way
 * to learn it had gone out was to open the Pending tab. Every roster action
 * that closes its dialog — send, resend, cancel, adding an existing member —
 * now confirms through the shell's one toast surface, whose region is a polite
 * live region, and names who and where. A partial organisation send keeps its
 * dialog open with the refusal inline and confirms nothing.
 *
 * Mounted rather than read from source: the toast is pushed from the same
 * branch that closes the dialog, and the order of those two is the behaviour.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/admin/people',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)

/*
 * The suite shares one process, so react-dom may have been loaded before any
 * DOM existed, and then it takes its legacy input path: it watches the focused
 * field through IE's attachEvent/detachEvent and reads a changed value on
 * keyup. jsdom has neither method, and a field React failed to release stays
 * "watched" across suites. This window's fields get permanent no-ops, so none
 * of them is ever left unreleasable; `type` below covers fields left behind
 * by another suite's window.
 */
type LegacyInputEvents = { attachEvent?: () => void; detachEvent?: () => void }
const legacyInputPrototype = dom.window.HTMLInputElement.prototype as HTMLInputElement & LegacyInputEvents
legacyInputPrototype.attachEvent = () => undefined
legacyInputPrototype.detachEvent = () => undefined

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { MemoryRouter } = await import('react-router-dom')
const { ApiClientProvider } = await import('@nessie/client-core')
const { AuthSessionProvider } = await import('../src/providers/AuthSessionProvider.js')
const { ToastProvider } = await import('../src/providers/ToastProvider.js')
const { MemberInvitationDialog } = await import(
  '../src/components/features/settings/MemberInvitationDialog.js'
)
const { MemberInvitationDetailsDialog } = await import(
  '../src/components/features/settings/MemberInvitationDetailsDialog.js'
)

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const installDom = () => {
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

type Call = { body?: unknown; method: string; path: string }
type Post = (path: string, body: unknown) => unknown

const TARGETS = [{ id: 'team-design', name: 'Design' }, { id: 'team-research', name: 'Research' }]

const mount = async (element: ReturnType<typeof h>, post: Post) => {
  const restoreDom = installDom()
  const previousFetch = globalThis.fetch
  // No signed-in account: the dialog then names the viewer's team as "your team".
  globalThis.fetch = (async () => new Response('{}', {
    headers: { 'content-type': 'application/json' },
    status: 401,
  })) as typeof fetch
  const calls: Call[] = []
  const getPage = async (path: string) => {
    calls.push({ method: 'GET', path })
    const items = path.startsWith('/api/team/members/candidates')
      ? [{ displayName: 'Ada Lovelace', email: 'ada@example.test', uoaSub: 'subject-ada' }]
      : TARGETS
    return {
      data: { items, permissions: { addMember: true, createInvitation: true } },
      meta: { hasMore: false, limit: 100, total: items.length },
    }
  }
  const client = {
    delete: async () => ({ ok: true }),
    get: getPage,
    getPage,
    patch: async () => ({ ok: true }),
    post: async (path: string, body: unknown) => {
      calls.push({ body, method: 'POST', path })
      return post(path, body)
    },
    put: async () => ({ ok: true }),
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h(QueryClientProvider, { client: queryClient },
      h(AuthSessionProvider, null,
        h(ApiClientProvider, { client: client as unknown as Parameters<typeof ApiClientProvider>[0]['client'] },
          h(MemoryRouter, { initialEntries: ['/admin/people'] },
            h(ToastProvider, null, element))))))
  })
  await settle()

  const body = dom.window.document.body
  const button = (label: string) => {
    const found = [...body.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.trim() === label)
    assert.ok(found, `no "${label}" button`)
    return found as HTMLButtonElement
  }
  return {
    body,
    button,
    calls,
    click: async (target: HTMLElement) => {
      await act(async () => target.click())
      // The request resolves, then the toast waits one settle before it shows.
      await settle()
      await settle()
    },
    toasts: () => [...body.querySelectorAll('.card-viewport [role="status"]')]
      .map((card) => card.textContent ?? ''),
    // Either React input path sees the change: `input` on the modern one,
    // `keyup` on the focused field for the legacy one described above. Moving
    // focus onto the field (a dialog may already have put it there) makes the
    // legacy path release whatever field it still watches — possibly one from
    // another suite's window, which shares this realm's Object.prototype — so
    // the no-ops sit there, for this one keystroke only.
    type: async (input: HTMLInputElement, value: string) => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      assert.ok(setValue, 'expected the native input value setter')
      const realm = Object.prototype as LegacyInputEvents
      for (const name of ['attachEvent', 'detachEvent'] as const) {
        Object.defineProperty(realm, name, { configurable: true, value: () => undefined, writable: true })
      }
      try {
        await act(async () => {
          input.blur()
          input.focus()
          setValue.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
          input.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
        })
      } finally {
        delete realm.attachEvent
        delete realm.detachEvent
      }
    },
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
      queryClient.clear()
      dom.window.localStorage.clear()
      globalThis.fetch = previousFetch
      restoreDom()
    },
  }
}

test('team lists read the way a person writes them', () => {
  assert.equal(joinNames(['Design']), 'Design')
  assert.equal(joinNames(['Design', 'Support']), 'Design and Support')
  assert.equal(joinNames(['Design', 'Research', 'Support']), 'Design, Research and Support')
  assert.equal(invitationSentToast('ada@example.test', []).body, 'ada@example.test is invited to your team.')
  assert.equal(memberAddedToast('Ada Lovelace', 'Design').body, 'Ada Lovelace is now in Design.')
})

test('an organisation invitation that goes out closes the dialog and names the address and every team', async () => {
  let closed = 0
  const harness = await mount(
    h(MemberInvitationDialog, { onClose: () => { closed += 1 }, open: true, scope: 'organization' }),
    () => ({ failedTeamIds: [], invitedTeamIds: ['team-design', 'team-research'], ok: true }),
  )
  try {
    await harness.click(harness.button('Select all'))
    await harness.type(harness.body.querySelector('#invite-email') as HTMLInputElement, 'ada@example.test')
    await harness.click(harness.button('Send invitation'))

    assert.equal(closed, 1)
    assert.deepEqual(harness.toasts(), ['Invitation sentada@example.test is invited to Design and Research.x'])
    assert.equal(harness.body.querySelector('.card-viewport')?.getAttribute('aria-live'), 'polite')
  } finally {
    await harness.unmount()
  }
})

test('a partial organisation send stays open, names both sides and confirms nothing', async () => {
  let closed = 0
  const harness = await mount(
    h(MemberInvitationDialog, { onClose: () => { closed += 1 }, open: true, scope: 'organization' }),
    () => ({ failedTeamIds: ['team-research'], invitedTeamIds: ['team-design'], ok: true }),
  )
  try {
    await harness.click(harness.button('Select all'))
    await harness.type(harness.body.querySelector('#invite-email') as HTMLInputElement, 'ada@example.test')
    await harness.click(harness.button('Send invitation'))

    assert.equal(closed, 0)
    assert.match(harness.body.textContent ?? '', /Invited to Design, but not to Research\. Send again to retry\./)
    assert.deepEqual(harness.toasts(), [])
  } finally {
    await harness.unmount()
  }
})

test('adding someone already in the organisation confirms who joined', async () => {
  let closed = 0
  const harness = await mount(
    h(MemberInvitationDialog, { onClose: () => { closed += 1 }, open: true, scope: 'team' }),
    () => ({ ok: true }),
  )
  try {
    await harness.type(harness.body.querySelector('#member-search') as HTMLInputElement, 'Ada')
    // The search is debounced before it asks the directory.
    await settle(250)
    await settle()
    const candidate = [...harness.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ada@example.test'))
    assert.ok(candidate, 'the matching organisation member is offered')
    await harness.click(candidate as HTMLButtonElement)

    assert.ok(harness.calls.some((call) => call.method === 'POST' && call.path === '/api/team/members'))
    assert.equal(closed, 1)
    assert.deepEqual(harness.toasts(), ['Member addedAda Lovelace is now in your team.x'])
  } finally {
    await harness.unmount()
  }
})

test('resending and cancelling a pending invitation each confirm with the address', async () => {
  const invitation = {
    email: 'pending@example.test',
    inviteId: 'invite-1',
    status: 'pending',
    team: { id: 'team-design', name: 'Design' },
  }
  const harness = await mount(
    h(MemberInvitationDetailsDialog, {
      canManage: true, invitation, onClose: () => undefined, scope: 'organization',
    }),
    () => ({ ok: true }),
  )
  try {
    await harness.click(harness.button('Resend'))
    assert.deepEqual(harness.calls.filter((call) => call.method === 'POST').map((call) => call.path),
      ['/api/organization/member-invitations/invite-1/resend'])
    assert.deepEqual(harness.toasts(), ['Invitation sent againWe’ve emailed pending@example.test again.x'])

    await harness.click(harness.button('Cancel invitation'))
    assert.match(harness.body.textContent ?? '', /Pending won’t be able to use it to join Design\./)
    await harness.click(harness.button('Cancel invitation'))
    assert.ok(harness.calls.some((call) => call.path === '/api/organization/member-invitations/invite-1/revoke'))
    assert.equal(harness.toasts()[0], 'Invitation cancelledYou can invite pending@example.test again at any time.x')
  } finally {
    await harness.unmount()
  }
})
