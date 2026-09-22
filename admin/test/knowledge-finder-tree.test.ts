import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replaceAll('\r\n', '\n')

test('Knowledge Finder exposes Tree, Columns and List views', () => {
  const view = readSource('../src/components/features/knowledge/finder/finder-view.ts')
  const documents = readSource('../src/components/features/knowledge/finder/DocumentsFinder.tsx')
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')

  assert.match(view, /FINDER_VIEWS = \['tree', 'columns', 'list'\]/)
  assert.match(view, /label: 'Tree'/)
  assert.match(view, /value: 'tree'/)
  assert.match(view, /case 'full':\n      return 'list'/)
  assert.match(documents, /view === 'tree'/)
  assert.match(documents, /<FinderTreePane/)
  assert.match(documents, /view === 'tree' && !single && !virtualColumnKey/)
  assert.match(documents, /rowsIn=\{rowsIn\}/)
  assert.match(tree, /rowsIn/)
  const sidebar = readSource('../src/components/features/knowledge/finder/FinderTreeSidebar.tsx')
  assert.match(sidebar, /Projects/)
  assert.match(sidebar, /Agents/)
  assert.match(sidebar, /Spaces/)
  assert.match(sidebar, /onOpenRoot/)
  assert.match(tree, /renderPages/)
})

test('Tree keeps the existing query recovery and avoids nested buttons', () => {
  const surface = readSource('../src/components/features/knowledge/finder/FinderTreeSurface.tsx')
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')
  const row = readSource('../src/components/features/knowledge/finder/FinderRow.tsx')
  const channels = readSource('../src/layouts/admin-shell/SidebarProjectsSection.tsx')

  assert.match(surface, /QueryState/)
  assert.match(surface, /Couldn’t load your documents\./)
  assert.match(surface, /EmptyState/)
  assert.doesNotMatch(row, /finder-row-chevron-button|onToggle/)
  assert.match(tree, /if \(children\.length > 0\) \{\s*toggle\(page\.id\)/)
  assert.match(tree, /className=\{depth > 0 \? 'sidebar-tree-depth' : ''\}/)
  assert.match(readSource('../src/styles.css'), /\.knowledge-sidebar-tree-panel \.finder-row-item \{[\s\S]*?list-style: none;/)
  assert.match(tree, /SidebarTreeNode/)
  assert.match(tree, /SidebarTreeChevron/)
  assert.match(tree, /SidebarTreeLeading/)
  assert.match(channels, /SidebarTreeNode/)
  assert.match(channels, /SidebarTreeChevron/)
})

test('opening a space makes it the New menu target and Tree creates folders in place', () => {
  const documents = readSource('../src/components/features/knowledge/finder/DocumentsFinder.tsx')
  const toolbar = readSource('../src/components/features/knowledge/finder/useFinderToolbar.ts')
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')

  assert.match(documents, /columnKey: `space:\$\{row\.space\.spaceId\}`, type: 'enterColumn'/)
  assert.doesNotMatch(toolbar, /onSelectView\('columns'\)/)
  assert.match(tree, /<NewFolderRow/)
  assert.match(tree, /createFolderColumnKey/)
  const sidebar = readSource('../src/components/features/knowledge/finder/FinderTreeSidebar.tsx')
  assert.match(sidebar, /setExpandedSpaces\(\(current\) => new Set\(\[\.\.\.current, selectedSpaceId\]\)\)/)
})

test('every folder view renders the shared inline folder row in place', () => {
  const documents = readSource('../src/components/features/knowledge/finder/DocumentsFinder.tsx')
  const columns = readSource('../src/components/features/knowledge/finder/FinderFolderColumn.tsx')
  const list = readSource('../src/components/features/knowledge/finder/FinderListView.tsx')
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')

  assert.match(columns, /<NewFolderRow/)
  assert.match(list, /<NewFolderRow/)
  assert.match(tree, /<NewFolderRow/)
  assert.match(documents, /creatingFolder=\{creatingFolderIn === levels\.at\(-1\)\?\.key\}/)
  assert.match(documents, /onSubmitFolder=\{\(name\) => submitFolder\(/)
  assert.match(documents, /levels\.at\(-1\)\?\.parentPageId \?\? null/)
})
