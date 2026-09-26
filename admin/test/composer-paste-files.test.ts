import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

/**
 * Pasting into the message composer's editor (`MentionInput`, drawn by the one
 * `ChannelComposer`).
 *
 * A screenshot on the clipboard is files and no text, and is handed over to be
 * staged exactly like a picked file. A paste from an app that puts a picture
 * of its text beside the text, as Excel does with cells, stays text, because
 * text is what the person copied. Staged files are a message on
 * their own, so Enter sends them with an empty draft, and holds the draft
 * while one is still uploading rather than posting without it.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/channels/c1',
})

const React = await import('react')
const { act, createElement: h, createRef } = React
const { createRoot } = await import('react-dom/client')
const { MentionInput } = await import('../src/components/shared/MentionInput.js')
type MentionInputProps = React.ComponentProps<typeof MentionInput>
type MentionInputHandle = import('../src/components/shared/MentionInput.js').MentionInputHandle

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  window: dom.window,
}

const installDom = () => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
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

const screenshot = () => new dom.window.File(['png bytes'], 'image.png', { type: 'image/png' })

const mount = async (initial: Partial<MentionInputProps> = {}) => {
  const restoreDom = installDom()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const handle = createRef<MentionInputHandle>()
  const pasted: File[][] = []
  const submitted: string[] = []
  let props: Partial<MentionInputProps> = initial

  const render = async (over: Partial<MentionInputProps> = {}) => {
    props = { ...props, ...over }
    await act(async () => {
      root.render(h(MentionInput, {
        entities: [],
        onPasteFiles: (files: File[]) => { pasted.push(files) },
        onSubmit: (text: string) => { submitted.push(text) },
        placeholder: 'Message',
        ref: handle,
        ...props,
      }))
    })
  }
  await render()

  const editor = container.querySelector('[role="textbox"]')
  assert.ok(editor instanceof dom.window.HTMLElement, 'the editor rendered')

  return {
    close: async () => {
      await act(async () => { root.unmount() })
      container.remove()
      restoreDom()
    },
    enter: async () => {
      await act(async () => {
        editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        }))
      })
    },
    // What a real clipboard offers: `getData` per type, and the files. A
    // screenshot has no text; Excel offers the cells' text and a picture.
    paste: async (clipboard: { files: File[]; text: string }) => {
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: clipboard.files,
          getData: (type: string) => (type === 'text/plain' ? clipboard.text : ''),
        },
      })
      await act(async () => {
        editor.dispatchEvent(event)
      })
      return event
    },
    pasted,
    render,
    submitted,
    text: () => handle.current?.getText() ?? '',
    type: async (text: string) => {
      await act(async () => { handle.current?.setText(text) })
    },
  }
}

test('a screenshot on the clipboard is handed over as files and types nothing', async () => {
  const composer = await mount()
  try {
    const image = screenshot()
    const event = await composer.paste({ files: [image], text: '' })
    assert.deepEqual(composer.pasted, [[image]])
    assert.equal(composer.text(), '')
    // The browser's own paste would drop an <img> into the editor.
    assert.equal(event.defaultPrevented, true)
  } finally {
    await composer.close()
  }
})

test('a paste that carries text stays text, even with a picture of it beside it', async () => {
  const composer = await mount()
  try {
    await composer.paste({ files: [screenshot()], text: 'Q3 revenue 41' })
    assert.deepEqual(composer.pasted, [])
    assert.equal(composer.text(), 'Q3 revenue 41')
  } finally {
    await composer.close()
  }
})

test('an editor that takes no files types nothing for a files-only paste', async () => {
  const composer = await mount({ onPasteFiles: undefined })
  try {
    await composer.paste({ files: [screenshot()], text: '' })
    assert.equal(composer.text(), '')
  } finally {
    await composer.close()
  }
})

test('Enter sends an empty draft only while staged files are the message', async () => {
  const composer = await mount()
  try {
    await composer.enter()
    assert.deepEqual(composer.submitted, [], 'nothing to send')

    await composer.render({ canSubmitEmpty: true })
    await composer.enter()
    assert.deepEqual(composer.submitted, [''])
  } finally {
    await composer.close()
  }
})

test('Enter holds the draft while a staged file is still uploading', async () => {
  const composer = await mount({ canSubmitEmpty: true, submitDisabled: true })
  try {
    await composer.type('what is wrong here?')
    await composer.enter()
    assert.deepEqual(composer.submitted, [])
    assert.equal(composer.text(), 'what is wrong here?', 'the draft stays put')

    await composer.render({ submitDisabled: false })
    await composer.enter()
    assert.deepEqual(composer.submitted, ['what is wrong here?'])
  } finally {
    await composer.close()
  }
})

test('the one chat composer stages pasted files and holds Enter for their uploads', () => {
  const composer = readFileSync(
    fileURLToPath(new URL('../src/components/features/channels/ChannelComposer.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(composer, /onPasteFiles=\{attachments\.addFiles\}/)
  assert.match(composer, /canSubmitEmpty=\{attachments\.attachmentIds\.length > 0\}/)
  assert.match(composer, /submitDisabled=\{[^}]*attachments\.isUploading\}/)
})
