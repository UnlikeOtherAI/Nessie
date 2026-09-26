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

test('file detail follows conversation detail with section tabs and keeps Download primary', () => {
  const file = source('../src/components/features/knowledge/FileNodeViewer.tsx')
  const actions = file.slice(file.indexOf('const headerActions'), file.indexOf('\n  ]', file.indexOf('const headerActions')))

  assert.match(file, /<TabBar ariaLabel="File sections"/)
  assert.match(file, /label: 'Preview'[\s\S]*?label: 'Attachments'[\s\S]*?label: 'Comments'/)
  assert.doesNotMatch(actions, /id: 'attachments'/)
  assert.match(actions, /id: 'history'[\s\S]*?title: 'Version history'/)
  assert.match(actions, /id: 'upload-version'[\s\S]*?title: 'Upload new version'/)
  assert.match(actions, /id: 'download'[\s\S]*?primary: true/)
  assert.doesNotMatch(file, /<h1/)
})

test('document detail follows conversation detail with section tabs and keeps Publish primary', () => {
  const preview = source('../src/components/features/knowledge/PagePreview.tsx')
  const actions = preview.slice(preview.indexOf('const headerActions'), preview.indexOf('\n  ]', preview.indexOf('const headerActions')))

  assert.match(preview, /<TabBar ariaLabel="Document sections"/)
  assert.match(preview, /label: 'Content'[\s\S]*?label: 'Attachments'[\s\S]*?label: 'Comments'/)
  assert.doesNotMatch(actions, /id: 'attachments'/)
  assert.match(actions, /id: 'history'[\s\S]*?title: 'Version history'/)
  assert.match(actions, /id: 'publish'[\s\S]*?primary: true/)
})
