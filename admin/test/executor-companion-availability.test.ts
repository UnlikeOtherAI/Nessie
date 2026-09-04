import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

import { ExecutorDesktopCompanionPanel } from '../src/components/features/executors/ExecutorDesktopCompanionPanel.js'
import { ShellEnvironmentProvider } from '../src/providers/ShellEnvironmentProvider.js'
import type {
  ExecutorCompanionAvailability,
  ExecutorCompanionStatusResponse,
} from '../src/lib/executor-companion.js'

/**
 * Rule zero applies to a capability's absence as much as its presence. The
 * panel used to answer any companion error by rendering `null`, so on a Linux
 * or Windows release it simply vanished and the person standing at
 * Agents → Executors was told nothing at all. The contract now is: the shell
 * answers with an availability state and a person-readable reason, and the
 * panel always says something — controls when the device can host an executor,
 * one explanatory card when it cannot.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/executors',
})

const React = await import('react')
const { act, createElement: h } = React
const { createRoot } = await import('react-dom/client')

const response = (
  availability: ExecutorCompanionAvailability,
  reason: string,
  operationKeys: string[] = ['file.read'],
): ExecutorCompanionStatusResponse => ({
  availability,
  executors: [{
    daemonStatus: 'stopped',
    executorId: 'exec-1',
    operationKeys,
    workspaceConfigured: true,
    workspaceLabel: 'Nessie work',
  }],
  platform: 'linux',
  reason,
})

const domGlobals = (extra: Record<string, unknown>) => ({
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: Object.assign(dom.window, extra),
})

const renderPanel = async (input: {
  desktop: boolean
  status?: ExecutorCompanionStatusResponse
  statusError?: string
}): Promise<string> => {
  const invoked: Record<string, unknown> = {
    __TAURI_INTERNALS__: {
      invoke: async () => {
        if (!input.status) throw input.statusError ?? 'companion unavailable'
        return input.status
      },
    },
    __nessieDesktopPlatform: 'linux',
  }
  const globals = domGlobals(input.desktop ? invoked : {})
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  if (!input.desktop) {
    delete (dom.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (dom.window as unknown as Record<string, unknown>).__nessieDesktopPlatform
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(ShellEnvironmentProvider, null, h(ExecutorDesktopCompanionPanel, { executorId: 'exec-1' })),
    )
  })
  const html = container.innerHTML
  await act(async () => root.unmount())
  container.remove()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  return html
}

test('the panel stays absent in a browser, where there is no companion to describe', async () => {
  assert.equal(await renderPanel({ desktop: false }), '')
})

test('an available companion renders the pairing and daemon controls', async () => {
  const html = await renderPanel({ desktop: true, status: response('available', 'Ready.') })
  assert.match(html, /Nessie Desktop companion/)
  assert.match(html, /Start daemon/)
  assert.match(html, /Local workspace policy/)
  assert.match(html, /Folder:.*Nessie work/)
  assert.match(html, /Change folder/)
  assert.match(html, /Forget pairing on this computer/)
  assert.equal((html.match(/checked=""/g) ?? []).length, 1)
  assert.doesNotMatch(html, /C:\\Users|\/home\//)
  assert.match(html, /requested file content and bounded result output are sent/)
  assert.doesNotMatch(html, /receives no .*executor runtime output/)
})

// The remedy is the companion's to word — it knows what this machine is missing
// and it is the only side that can say so without leaking a local path.
test('a device that cannot host an executor gets one card carrying the shell’s reason', async () => {
  for (const availability of [
    'runtime_missing',
    'unsigned_release',
    'unsupported_platform',
  ] as const) {
    const reason = `Reason for ${availability}. Reinstall from the signed release.`
    const html = await renderPanel({ desktop: true, status: response(availability, reason) })
    assert.match(html, /Nessie Desktop companion/)
    assert.match(html, new RegExp(reason.replace(/[.]/g, '\\.')))
    assert.doesNotMatch(html, /Start daemon/, `${availability} offers no daemon control`)
    assert.doesNotMatch(html, /Local workspace policy/)
    assert.equal((html.match(/admin-card/g) ?? []).length, 1, `${availability} renders one card`)
  }
})

// workspace_only is the one state that is both: the machine really can pair, so
// the controls stay, and the card says what it will not be able to do.
test('workspace_only keeps the controls and adds the explanation beside them', async () => {
  const reason =
    'This computer can pair as an executor for file review and drafts. Sandboxed commands, browsers and coding sessions need virtualization: add your user to the kvm group and sign in again.'
  const html = await renderPanel({ desktop: true, status: response('workspace_only', reason) })
  assert.match(html, /This computer can pair for file review and drafts/)
  assert.match(html, /add your user to the kvm group/)
  assert.match(html, /Start daemon/)
})

test('a native command error remains visible verbatim', async () => {
  const message = 'Signed companion refused this exact local action.'
  const html = await renderPanel({ desktop: true, statusError: message })
  assert.match(html, /Nessie Desktop companion/)
  assert.match(html, new RegExp(message.replace(/[.]/g, '\\.')))
  assert.doesNotMatch(html, /Nessie Desktop could not complete/)
})
