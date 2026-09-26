import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('Tree detail omits its redundant Back while other Finder views retain it', () => {
  const pane = source('../src/components/features/knowledge/KnowledgeDocumentPane.tsx')

  assert.match(pane, /const detailBack = view === 'tree' \? undefined : onBack/)
  assert.match(pane, /<FileNodeViewer[\s\S]*?onBack=\{detailBack\}/)
  assert.match(pane, /<PagePreview[\s\S]*?onBack=\{detailBack\}/)
  assert.match(pane, /<SpreadsheetPane[\s\S]*?onBack=\{detailBack\}/)
})

test('file detail keeps sections inline and Download in the floating action bar', () => {
  const file = source('../src/components/features/knowledge/FileNodeViewer.tsx')
  const actions = file.slice(file.indexOf('const detailActions'), file.indexOf('\n  ]', file.indexOf('const detailActions')))

  assert.doesNotMatch(file, /<TabBar ariaLabel="File sections"/)
  assert.match(file, /<AttachmentsDrawer[\s\S]*?<CommentsSection/)
  assert.doesNotMatch(actions, /id: 'attachments'/)
  assert.match(actions, /id: 'history'[\s\S]*?title: 'Version history'/)
  assert.match(actions, /id: 'upload-version'[\s\S]*?title: 'Upload new version'/)
  assert.match(actions, /id: 'download'[\s\S]*?primary: true/)
  assert.match(file, /bottomActions=\{detailActions\}/)
})

test('document detail keeps sections inline and Publish in the floating action bar', () => {
  const preview = source('../src/components/features/knowledge/PagePreview.tsx')
  const actions = preview.slice(preview.indexOf('const detailActions'), preview.indexOf('\n  ]', preview.indexOf('const detailActions')))

  assert.doesNotMatch(preview, /<TabBar ariaLabel="Document sections"/)
  assert.match(preview, /<AttachmentsDrawer[\s\S]*?<CommentsSection/)
  assert.doesNotMatch(actions, /id: 'attachments'/)
  assert.match(actions, /id: 'history'[\s\S]*?title: 'Version history'/)
  assert.match(actions, /id: 'publish'[\s\S]*?primary: true/)
  assert.match(preview, /bottomActions=\{detailActions\}/)
})
