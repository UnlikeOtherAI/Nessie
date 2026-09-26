import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath: string): string =>
  readFileSync(new URL(`../src/components/features/knowledge/${relativePath}`, import.meta.url), 'utf8')

const editor = read('PageEditor.tsx')
const preview = read('PagePreview.tsx')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const workspace = read('KnowledgeWorkspace.tsx')

test('the page editor is a borderless writing canvas with descriptive placeholders', () => {
  assert.match(editor, /placeholder="Give this document a title…"/)
  assert.match(editor, /aria-label="Document title"/)
  assert.match(editor, /kb-document-title/)
  assert.match(editor, /title=\{mode === 'create' \? 'New document' : 'Edit document'\}/)
  assert.match(editor, /\? 'Publish'/)
  assert.match(editor, /label: pending \? 'Saving…' : 'Save as draft'/)
  assert.match(editor, /mode === 'create' && publishOnCreate\.current/)
  assert.match(styles, /\.kb-document-title\s*\{[^}]*font-size: 3rem/)
  assert.match(styles, /@media \(min-width: 640px\)[\s\S]*?\.kb-document-title\s*\{[^}]*font-size: 4rem/)
  assert.doesNotMatch(editor, /Create page|New page|Edit page/)
  assert.match(editor, /placeholder="Start writing…"/)
  assert.match(editor, /placeholder=\{committedLabels\.length \? 'Add another label…' : 'Add labels…'\}/)
  assert.doesNotMatch(editor, /label="Title"|label="Summary"|label="Body"/)

  const richText = read('RichTextEditor.tsx')
  assert.doesNotMatch(richText, /kb-editor[^\n]*rounded[^\n]*border/)
})

test('document title uses its display serif and the rich-text toolbar uses channel-style icon controls', () => {
  const toolbar = readFileSync(new URL('../src/components/shared/markdown-editor/RichTextToolbar.tsx', import.meta.url), 'utf8')
  assert.match(styles, /--font-family-document-title: Georgia, 'Times New Roman', serif/)
  assert.match(styles, /\.kb-document-title\s*\{[^}]*font-family: var\(--font-family-document-title\)/)
  assert.match(toolbar, /admin-compose-action flex h-7 w-7/)
  for (const icon of ['faBold', 'faItalic', 'faHeading', 'faListUl', 'faListOl', 'faQuoteLeft', 'faCode', 'faFileCode', 'faLink']) {
    assert.match(toolbar, new RegExp(`\\b${icon}\\b`))
  }
  assert.doesNotMatch(toolbar, /label="🔗"|label="❝"|label="\{ \}"/)
})

test('new pages can choose only an existing folder as their parent', () => {
  assert.match(editor, /aria-label="Folder"/)
  assert.match(editor, /page\.kind === 'folder'/)
  assert.match(editor, /parentOptions\(pages\)/)
  assert.match(editor, /parentPageId: mode === 'create' \? draftParentPageId : undefined/)
  assert.match(workspace, /pages=\{pages\}/)
  // "Documents", not "Pages": the section, the root row and the editor's
  // breadcrumb all say the word the owner uses.
  assert.match(workspace, /spaceName=\{spaceDisplayName\}/)
})

test('an open document is a leaf without creation or child-page UI', () => {
  assert.doesNotMatch(preview, /new-sub-page|Sub-pages|No sub-pages|onCreateChild|subPages/)
})

test('published pages use a three-dot actions menu instead of redundant publication UI', () => {
  assert.match(preview, /icon: faEllipsis/)
  assert.match(preview, /kind: 'menu'/)
  assert.match(preview, /label: 'History'/)
  assert.match(preview, /label: 'Archive document'/)
  assert.match(preview, /page\.status !== 'published'/)
  assert.doesNotMatch(preview, /<Pill[^>]*>[\s\S]*?published[\s\S]*?<\/Pill>/)
})

test('archiving a page uses the existing endpoint and returns to its parent', () => {
  const hooks = read('../../../facades/knowledge/hooks.ts')
  const mutations = read('useKnowledgeMutations.ts')
  assert.match(hooks, /apiClient\.delete<KnowledgePageRecord>/)
  assert.match(mutations, /const nextPath = pageIndex >= 0 \? currentPath\.slice\(0, pageIndex\) : \[\]/)
  assert.match(mutations, /setOpenPageId\(nextPath\.at\(-1\)\)/)
})

test('the document preview shows a clickable breadcrumb trail from its space', () => {
  assert.match(preview, /aria-label="Page breadcrumbs"/)
  assert.match(preview, /onClick=\{onBrowseRoot\}/)
  assert.match(preview, /onOpenBreadcrumb\(breadcrumb\.id\)/)
  assert.match(preview, /aria-current="page"/)
})

test('saving follows a parent changed in the editor location picker', () => {
  const mutations = read('useKnowledgeMutations.ts')
  assert.match(mutations, /const parentPageId = input\.parentPageId \?\? null/)
  assert.match(mutations, /setPagePath\(\[\.\.\.parentPath, created\.id\]\)/)
})

test('new documents can be published in the create flow while drafts stay unpublished', () => {
  const mutations = read('useKnowledgeMutations.ts')
  assert.match(editor, /onSubmit: \(input: SavePageInput, publish\?: boolean\)/)
  assert.match(mutations, /async \(input: SavePageInput, publish = false\)/)
  assert.match(mutations, /if \(publish\) await publishPageMutation\.mutateAsync\(\{ pageId: created\.id \}\)/)
  assert.match(editor, /mode === 'create'[\s\S]*?\? 'Publish'[\s\S]*?: 'Save version'/)
})

test('the open folder expands into the next column of the Finder', () => {
  // The page hierarchy used to be a disclosure tree inside the navy sidebar.
  // With the sidebar gone, walking into a folder is what opens the next
  // column — one browser, not a tree beside it (browser-ui.md §4, Rejected).
  const finder = read('finder/DocumentsFinder.tsx')
  assert.match(finder, /key: `folder:\$\{folder\.id\}`/)
  assert.match(finder, /parentPageId: folder\.id/)
  assert.match(finder, /browseTo\(\[\.\.\.prefix, page\.id\]\)/)
  assert.match(finder, /dispatch\(\{ columnKey: `folder:\$\{page\.id\}`, type: 'enterColumn' \}\)/)
})
