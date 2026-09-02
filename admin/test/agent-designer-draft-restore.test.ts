import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// A stored designer draft must survive the designer's own mount. The form
// mirrors its reducer into the draft from an effect; on the mount render that
// reducer still holds the empty baseline, and writing it before the hook's
// restore landed counted as "nothing to store" — which deleted the very
// draft the person came back for (docs/navigation/overview.md §15).

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('a stored agent-designer draft is restored on mount, not wiped by the mount mirror', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
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
    const { useAgentDesigner } = await import('../src/components/features/agents/designer/useAgentDesigner')
    const { draftKey } = await import('../src/navigation/useDraft')

    const key = draftKey('agent-designer', 'new') as string
    dom.window.localStorage.setItem(key, JSON.stringify({
      effort: 'medium',
      model: '',
      name: 'Draft Agent Probe',
      provider: '',
      role: 'assistant',
      runLimits: { maxCostCents: '', maxIterations: '', maxTokens: '', maxToolCalls: '', maxWallclockMs: '' },
      selectedTools: [],
      streamingField: null,
      systemPrompt: 'Keep going',
      todosEnabled: false,
      visibility: 'workspace',
    }))

    let seenName = ''
    const Probe = () => {
      const designer = useAgentDesigner()
      seenName = designer.state.name
      return h('p', null, designer.state.name)
    }
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(h(Probe)))
      await settle(act)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
      assert.equal(seenName, 'Draft Agent Probe')
      const stored = dom.window.localStorage.getItem(key)
      assert.ok(stored && stored.includes('Draft Agent Probe'), `draft still stored: ${stored}`)
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
})
