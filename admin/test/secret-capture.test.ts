import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

import { maskSecretValue } from '@nessie/schemas'
import type { SecretCapture } from '../src/components/features/channels/useSecretCapture.js'
import { stubResizeObserver } from './support/resize-observer-stub'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

// Assembled, so no scanner reads the source itself as carrying a key.
const KEY = ['sk', 'proj', 'TESTONLY0123456789abcdefghij'].join('-')

const captureOf = (projectId?: string): SecretCapture => ({
  agentMentions: [],
  detected: { end: KEY.length, prefix: 'sk-proj-', start: 0, type: 'openai_api_key' },
  ...(projectId ? { projectId } : {}),
  replacementContent: `sk-proj-${'•'.repeat(12)}`,
  replacementMode: 'message',
  value: KEY,
})

/**
 * The real dialog over a client that records what Save posts. It portals to
 * the document body, so everything is read from there.
 */
const openCaptureForm = async (capture: SecretCapture) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost:5455/channels/c1',
  })
  stubResizeObserver(dom.window as unknown as Window & typeof globalThis)
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const { MemoryRouter } = await import('react-router-dom')
  const { ApiClientProvider } = await import('@nessie/client-core')
  const { SecretCaptureDialog } = await import(
    '../src/components/features/channels/SecretCaptureDialog.js'
  )

  const posted: { body: Record<string, unknown>; path: string }[] = []
  const saved: string[] = []
  const client = {
    post: async (path: string, body: Record<string, unknown>) => {
      posted.push({ body, path })
      return { name: body.name, scopeType: body.scopeType }
    },
  } as never
  // No garbage-collection timer: loaded beside a window, react-query would
  // otherwise hold the process open for five minutes after the last test.
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { gcTime: Infinity, retry: false } },
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h(QueryClientProvider, { client: queryClient },
      h(ApiClientProvider, { client },
        h(MemoryRouter, { initialEntries: ['/channels/c1'] },
          h(SecretCaptureDialog, {
            capture,
            onClose: () => undefined,
            onSaved: async (secret: { name: string }) => { saved.push(secret.name) },
          })))))
  })

  const scope = dom.window.document.body.querySelector('select')
  assert.ok(scope, 'the Scope control rendered')
  return {
    choose: async (value: string) => {
      await act(async () => {
        scope.value = value
        scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    },
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    },
    options: () => Array.from(scope.options, (option) => option.value),
    posted,
    save: async () => {
      const form = scope.closest('form')
      assert.ok(form, 'the Scope control sits in the form')
      await act(async () => {
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
        await new Promise((settle) => setTimeout(settle, 0))
      })
    },
    saved,
    scope: () => scope.value,
  }
}

test('the capture form renders only a provider prefix and bullet mask', () => {
  const raw = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz0123456789', 'ABCD'].join('_')
  const masked = maskSecretValue(raw, 'github_token')

  assert.equal(masked, `github_pat_${'•'.repeat(12)}`)
  assert.doesNotMatch(masked, /abcdefghijklmnopqrstuvwxyz/)

  const dialog = readSource('../src/components/features/channels/SecretCaptureDialog.tsx')
  assert.match(dialog, /<Dialog/)
  assert.match(dialog, /value=\{maskSecretValue\(capture\.value, capture\.detected\.type\)\}/)
  assert.doesNotMatch(dialog, /value=\{capture\.value\}/)
})

test('both message composers hold a credential through the one capture hook', () => {
  const composer = readSource('../src/components/features/channels/useChannelComposer.ts')
  const newMessage = readSource('../src/pages/ChannelConversationComposePage.tsx')
  // A room's composer offers a project only through the one rule — never the
  // room's own `projectId`, which a DM carries too. New message has no room.
  assert.match(composer, /const viewerIsOwner = useIsOwner\(\)/)
  assert.match(
    composer,
    /useSecretCapture\(\{ projectId: secretCaptureProjectId\(activeChannel, \{ viewerIsOwner \}\) \}\)/,
  )
  assert.doesNotMatch(composer, /projectId: activeChannel\?\.projectId/)
  assert.match(newMessage, /useSecretCapture\(\{ projectId: null \}\)/)
  for (const source of [composer, newMessage]) {
    assert.doesNotMatch(
      source,
      /extractDetectedSecretValue|redactDetectedSecrets|Secret protected and saved/,
    )
  }
})

test('every channel composer doorway owns the same capture form', () => {
  const callSites = [
    '../src/pages/channels/ThreadInboxCard.tsx',
    '../src/pages/channels/ChannelConversationSurface.tsx',
    '../src/components/features/channels/ChannelAgentInfoDrawer.tsx',
    '../src/components/features/channels/ChannelUserInfoDrawer.tsx',
    '../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
    '../src/pages/ChannelConversationComposePage.tsx',
  ]

  for (const callSite of callSites) {
    const source = readSource(callSite)
    assert.match(source, /secretCapture=\{(?:composer\.)?secretCapture\}/, callSite)
    assert.match(
      source,
      /onConfirmSecretCapture=\{(?:composer\.)?confirmSecretCapture\}/,
      callSite,
    )
    assert.match(
      source,
      /onDismissSecretCapture=\{(?:composer\.)?dismissSecretCapture\}/,
      callSite,
    )
  }
})

test('the capture form opens on Personal even where a project is offered', async () => {
  const form = await openCaptureForm(captureOf('project-1'))
  try {
    assert.equal(form.scope(), 'personal')
    assert.deepEqual(form.options(), ['personal', 'project'])
    await form.save()
    // Saving at the default names no project, so nobody else is given the
    // credential and no role the server refuses is asked for.
    assert.deepEqual(form.posted, [{
      body: { name: 'OPENAI_API_KEY', scopeType: 'personal', value: KEY },
      path: '/api/secrets',
    }])
    assert.deepEqual(form.saved, ['OPENAI_API_KEY'])
  } finally {
    await form.close()
  }
})

test('the offered project is saved only when the person picks it', async () => {
  const form = await openCaptureForm(captureOf('project-1'))
  try {
    await form.choose('project')
    await form.save()
    assert.deepEqual(form.posted.map((entry) => entry.body), [
      { name: 'OPENAI_API_KEY', scopeId: 'project-1', scopeType: 'project', value: KEY },
    ])
  } finally {
    await form.close()
  }
})

test('with no project offered, Personal is the only scope', async () => {
  const form = await openCaptureForm(captureOf())
  try {
    assert.deepEqual(form.options(), ['personal'])
    await form.save()
    assert.deepEqual(form.posted.map((entry) => entry.body), [
      { name: 'OPENAI_API_KEY', scopeType: 'personal', value: KEY },
    ])
  } finally {
    await form.close()
  }
})
