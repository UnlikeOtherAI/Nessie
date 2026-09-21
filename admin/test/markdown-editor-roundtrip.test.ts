import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import type { Editor as EditorType } from '@tiptap/core'

/**
 * The Markdown field's acceptance test (ui.md §5.8, delivery §6.7): whatever
 * the pinned `@tiptap/markdown` calls its methods, text written in the ticket
 * editor must survive being opened and saved again. `serialise(parse(md))` is
 * a fixed point after one pass, over every construct the toolbar offers plus
 * the inline-image form.
 *
 * It drives the editor's own extension set (`createMarkdownEditorExtensions`),
 * headless, so a change to the schema or the Markdown handling is measured
 * here rather than in a browser.
 */

const ATTACHMENT = '/api/attachments/11111111-1111-4111-8111-111111111111'

const FIXTURES: Record<string, string> = {
  'headings 2 and 3': '## Heading two\n\n### Heading three\n\nBody under it.',
  'nested bullet list': '- one\n- two\n  - nested a\n  - nested b\n- three',
  'nested ordered list': '1. first\n2. second\n   1. inner\n3. third',
  'mixed nesting': '- parent\n  1. child one\n  2. child two\n- sibling',
  link: 'Read [the spec](https://example.com/spec?x=1) first.',
  'inline code': 'Call `useTaskComments(taskId)` from the section.',
  'fenced code': '```ts\nconst answer = 42\nconsole.log(answer)\n```',
  'fenced code without a language': '```\nplain block\n```',
  'attachment image alone': `![shot](${ATTACHMENT})`,
  'attachment image between paragraphs': `Before the image.\n\n![Screen shot](${ATTACHMENT})\n\nAfter it.`,
  'plain text with line break': 'line one\nline two',
  'emphasis': '**bold**, *italic* and ***both***',
  quote: '> quoted text\n\nand a reply',
  'characters Markdown would read as syntax': 'a_b * c [x] 1. not a list',
  'code block last in the document': 'Intro\n\n```js\nlet x = 1\n```',
}

type Globals = Record<'window' | 'document' | 'Node' | 'HTMLElement' | 'getComputedStyle', unknown>
const GLOBAL_NAMES = ['window', 'document', 'Node', 'HTMLElement', 'getComputedStyle'] as const
const { window: domWindow } = new JSDOM('<!doctype html><html><body></body></html>')

/**
 * The admin's tests share one process (`--experimental-test-isolation=none`),
 * and other files install and remove their own DOM globals between tests. So
 * this file's DOM is put in place around each synchronous editor use and put
 * back straight after, rather than once for the file.
 */
const withDom = <T>(run: () => T): T => {
  const scope = globalThis as unknown as Globals
  const saved = Object.fromEntries(GLOBAL_NAMES.map((name) => [name, scope[name]]))
  Object.assign(scope, {
    document: domWindow.document,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    window: domWindow,
  })
  try {
    return run()
  } finally {
    Object.assign(scope, saved)
  }
}

let Editor: typeof EditorType
let extensions: () => ReturnType<typeof import('../src/components/shared/markdown-editor/MarkdownEditor.js').createMarkdownEditorExtensions>
let serialize: typeof import('../src/components/shared/markdown-editor/markdown-editor-upload.js').serializeEditorMarkdown

before(async () => {
  Editor = (await import('@tiptap/core')).Editor
  const editorModule = await import('../src/components/shared/markdown-editor/MarkdownEditor.js')
  extensions = () => editorModule.createMarkdownEditorExtensions({ placeholder: '' })
  serialize = (await import('../src/components/shared/markdown-editor/markdown-editor-upload.js')).serializeEditorMarkdown
})

const withEditor = <T>(markdown: string, read: (editor: EditorType) => T): T =>
  withDom(() => {
    const editor = new Editor({ content: markdown, contentType: 'markdown', extensions: extensions() })
    try {
      return read(editor)
    } finally {
      editor.destroy()
    }
  })

/** Open the text in the editor and save it, as a person reopening a ticket does. */
const roundTrip = (markdown: string): string =>
  withEditor(markdown, (editor) => {
    // Re-seed through `setContent`, the path an external value change takes,
    // so the trailing-node plugin gets its chance to add a paragraph.
    editor.commands.setContent(markdown, { contentType: 'markdown' })
    return serialize(editor)
  })

for (const [name, markdown] of Object.entries(FIXTURES)) {
  test(`round-trip is a fixed point after one pass: ${name}`, () => {
    const once = roundTrip(markdown)
    const twice = roundTrip(once)
    assert.equal(twice, once, `drifted:\n${JSON.stringify(once)}\n→\n${JSON.stringify(twice)}`)
  })
}

test('the constructs survive as themselves, not as lookalikes', () => {
  assert.equal(roundTrip(FIXTURES['headings 2 and 3']!), FIXTURES['headings 2 and 3'])
  assert.equal(roundTrip(FIXTURES['nested bullet list']!), FIXTURES['nested bullet list'])
  assert.equal(roundTrip(FIXTURES.link!), FIXTURES.link)
  assert.equal(roundTrip(FIXTURES['inline code']!), FIXTURES['inline code'])
  assert.equal(roundTrip(FIXTURES['fenced code']!), FIXTURES['fenced code'])
})

test('an attachment image keeps the one inline form, alt text included', () => {
  const out = roundTrip(FIXTURES['attachment image between paragraphs']!)
  assert.match(out, /!\[Screen shot\]\(\/api\/attachments\/11111111-1111-4111-8111-111111111111\)/)
  withEditor(`![shot](${ATTACHMENT})`, (editor) => {
    const image = editor.getJSON().content?.[0]
    const node = image?.type === 'paragraph' ? image.content?.[0] : image
    assert.equal(node?.type, 'image')
    assert.equal(node?.attrs?.src, ATTACHMENT)
    assert.equal(node?.attrs?.alt, 'shot')
  })
})

test('a document ending in a block does not grow a blank line per save', () => {
  for (const markdown of [FIXTURES['nested bullet list']!, FIXTURES['fenced code']!, FIXTURES.quote!]) {
    assert.doesNotMatch(roundTrip(markdown), /\n$/)
  }
})

test('an upload placeholder is never content', () => {
  withEditor('Before', (editor) => {
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      attrs: { filename: 'shot.png', uploadId: 'u-1' },
      type: 'imageUpload',
    })
    assert.ok(JSON.stringify(editor.getJSON()).includes('imageUpload'))
    assert.equal(serialize(editor).trim(), 'Before')
  })
})

test('the empty field is the empty string', () => {
  assert.equal(roundTrip(''), '')
})
