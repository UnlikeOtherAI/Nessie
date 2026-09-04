import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath: string): string =>
  readFileSync(new URL(`../src/components/features/knowledge/${relativePath}`, import.meta.url), 'utf8')

const editor = read('PageEditor.tsx')
const preview = read('PagePreview.tsx')
const workspace = read('KnowledgeWorkspace.tsx')

test('the page editor is a borderless writing canvas with descriptive placeholders', () => {
  assert.match(editor, /placeholder="Give this page a title…"/)
  assert.match(editor, /placeholder="Start writing…"/)
  assert.match(editor, /placeholder="Add labels, separated by commas"/)
  assert.doesNotMatch(editor, /label="Title"|label="Summary"|label="Body"/)

  const richText = read('RichTextEditor.tsx')
  assert.doesNotMatch(richText, /kb-editor[^\n]*rounded[^\n]*border/)
})

test('new pages can choose an existing document as their parent', () => {
  assert.match(editor, /aria-label="Parent page"/)
  assert.match(editor, /parentOptions\(pages\)/)
  assert.match(editor, /parentPageId: mode === 'create' \? draftParentPageId : undefined/)
  assert.match(workspace, /pages=\{pages\}/)
  assert.match(workspace, /spaceName=\{selectedSpace\?\.name \?\? 'Pages'\}/)
})

test('an open document exposes the New page doorway in its header and child section', () => {
  assert.match(preview, /id: 'new-sub-page'/)
  assert.match(preview, /label: 'New page'/)
  assert.ok((preview.match(/onCreateChild/g) ?? []).length >= 4)
})

test('the document preview shows a clickable breadcrumb trail from its space', () => {
  assert.match(preview, /aria-label="Page breadcrumbs"/)
  assert.match(preview, /onClick=\{onBrowseRoot\}/)
  assert.match(preview, /onOpenBreadcrumb\(breadcrumb\.id\)/)
  assert.match(preview, /aria-current="page"/)
})

test('saving follows a parent changed in the editor location picker', () => {
  const provider = read('KnowledgeProvider.tsx')
  assert.match(provider, /const parentPageId = input\.parentPageId \?\? null/)
  assert.match(provider, /setPagePath\(\[\.\.\.parentPath, created\.id\]\)/)
})

test('the selected Space expands into the page hierarchy in the left sidebar', () => {
  const sidebar = read('../../../layouts/admin-shell/KnowledgeSidebarNav.tsx')
  const tree = read('KnowledgeSidebarPageTree.tsx')
  assert.match(sidebar, /<KnowledgeSidebarPageTree/)
  assert.match(sidebar, /activePageId=\{showSelectedSpace \? openPageId : undefined\}/)
  assert.match(sidebar, /openPagePath\(path\)/)
  assert.match(tree, /childrenOf\(page\.id\)/)
  assert.match(tree, /aria-current=\{sidebarAriaCurrent\(active\)\}/)
})
