import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// What a successful save leaves on the screen.
//
// Saving clears the draft, and `useDraft.clear()` puts the form back to the
// `initial` value it was given — for this form, the agent record as it was
// when the page mounted. The designer's restore effect then dispatched that
// value over the reducer, so a save that HAD succeeded repainted the form with
// the values it had just replaced, and left them there until a reload. The
// person sees their change vanish at exactly the moment they are looking for
// confirmation that it landed.
//
// A save settles the form on what was saved: the baseline moves to the saved
// values, and the stored draft goes, because nothing is unsent any more.

const settle = async (act: (callback: () => Promise<void>) => Promise<void>): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const withDom = async (run: (dom: JSDOM) => Promise<void>): Promise<void> => {
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
    await run(dom)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

const KIMI = {
  displayName: 'Kimi for Coding',
  model: 'kimi-for-coding',
  provider: 'subscription/kimi',
  providerDisplayName: 'Kimi for Coding',
}

test('a saved agent-designer form keeps the saved values, not the ones it replaced', async () => {
  await withDom(async (dom) => {
    const React = await import('react')
    const { act, createElement: h } = React
    const { createRoot } = await import('react-dom/client')
    const { useAgentDesigner } = await import(
      '../src/components/features/agents/designer/useAgentDesigner'
    )
    const { draftKey } = await import('../src/navigation/useDraft')

    const agentId = 'e1d4b0de-0000-4000-8000-00000000f00d'
    const key = draftKey('agent-designer', agentId) as string

    // Edit mode: the form is seeded from the stored agent, exactly as
    // `AgentDesignerPage` seeds it from `editingAgent`.
    const initialState = {
      model: 'glm-4.6',
      name: 'Plan Switch Probe',
      provider: 'subscription/glm',
      role: 'assistant',
    }

    let seen = { model: '', provider: '' }
    let pickKimi = () => {}
    let save = () => {}
    const Probe = () => {
      const designer = useAgentDesigner(initialState, [KIMI], agentId)
      seen = { model: designer.state.model, provider: designer.state.provider }
      pickKimi = () => designer.actions.setModelSelection(KIMI)
      // What `handleSave` does once the PUT has returned: the values on the
      // form are the stored ones now.
      save = () => designer.markSaved(designer.state)
      return h('p', null, designer.state.model)
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(h(Probe)))
      await settle(act)
      assert.equal(seen.model, 'glm-4.6', 'form starts on the stored model')

      await act(async () => pickKimi())
      await settle(act)
      assert.equal(seen.model, 'kimi-for-coding', 'the pick lands on the form')

      // Past the draft's local debounce, so there is a stored draft to clear.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
      assert.ok(dom.window.localStorage.getItem(key), 'an unsent edit is buffered')

      await act(async () => save())
      await settle(act)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })

      assert.deepEqual(
        seen,
        { model: 'kimi-for-coding', provider: 'subscription/kimi' },
        'the form still shows what was saved',
      )
      // Nothing is unsent any more, so no draft may survive the save — one
      // that did would "restore" the saved values on the next mount and mark
      // a settled form as carrying unsent work.
      assert.equal(dom.window.localStorage.getItem(key), null, 'the stored draft is gone')
    } finally {
      await act(async () => root.unmount())
    }
  })
})

test('a save settles the form even when the draft never reached storage', async () => {
  await withDom(async (dom) => {
    const React = await import('react')
    const { act, createElement: h } = React
    const { createRoot } = await import('react-dom/client')
    const { useAgentDesigner } = await import(
      '../src/components/features/agents/designer/useAgentDesigner'
    )

    const agentId = 'e1d4b0de-0000-4000-8000-00000000beef'
    const initialState = {
      model: 'glm-4.6',
      name: 'Quick Save',
      provider: 'subscription/glm',
      role: 'assistant',
    }

    let seenModel = ''
    let pickAndSave = () => {}
    const Probe = () => {
      const designer = useAgentDesigner(initialState, [KIMI], agentId)
      seenModel = designer.state.model
      pickAndSave = () => {
        designer.actions.setModelSelection(KIMI)
        designer.markSaved({ ...designer.state, model: KIMI.model, provider: KIMI.provider })
      }
      return h('p', null, designer.state.model)
    }

    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(h(Probe)))
      await settle(act)
      // Saving inside the 300ms local debounce window: the clear races the
      // buffered write, and the form must still settle on the saved values.
      await act(async () => pickAndSave())
      await settle(act)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })

      assert.equal(seenModel, 'kimi-for-coding')
    } finally {
      await act(async () => root.unmount())
    }
  })
})
