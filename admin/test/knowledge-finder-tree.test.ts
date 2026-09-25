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
  assert.doesNotMatch(documents, /view === 'tree'[^?]+!agentsDirectoryOpen/)
  assert.match(documents, /detail=\{treeDetail\}/)
  assert.match(documents, /<FinderTreeDetail/)
  const detail = readSource('../src/components/features/knowledge/finder/FinderTreeDetail.tsx')
  assert.match(detail, /if \(documentPane\) return documentPane/)
  assert.match(detail, /if \(agentsDirectoryActive\)/)
  assert.match(detail, /if \(!agentDocumentsActive\) return null/)
  assert.match(documents, /rowsIn=\{rowsIn\}/)
  assert.match(tree, /rowsIn/)
  const sidebar = readSource('../src/components/features/knowledge/finder/FinderTreeSidebar.tsx')
  assert.match(sidebar, /Projects/)
  assert.match(sidebar, /Agents/)
  assert.match(sidebar, /Spaces/)
  assert.match(sidebar, /onOpenRoot/)
  assert.match(tree, /renderPages/)
})

test('Tree owns the adjacent document pane while other views keep full-surface detail', () => {
  const workspace = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')
  const documents = readSource('../src/components/features/knowledge/finder/DocumentsFinder.tsx')
  const pane = readSource('../src/components/features/knowledge/finder/FinderTreePane.tsx')

  assert.match(workspace, /documentPane=\{!stacked && documentOpen \? documentPane : undefined\}/)
  assert.match(documents, /documentPane && view !== 'tree'/)
  assert.match(documents, /absolute inset-0 z-\[1\]/)
  assert.match(pane, /border-l border-\[color:var\(--sep\)\]/)
  assert.match(pane, /\{detail\}/)
})

test('Tree rows use channel-style icons and contextual selection', () => {
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(tree, /const TreeItemIcon/)
  assert.match(tree, /kind === 'spreadsheet'/)
  assert.match(tree, /<TreeItemIcon kind=\{page\.kind\}/)
  assert.match(tree, /tree\s+variant="item"/)
  assert.match(styles, /data-finder-tree-row='true'/)
  assert.match(styles, /color-mix\(in srgb, var\(--sb-active\) 20%, transparent\)/)
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
  const rootNavigation = readSource('../src/components/features/knowledge/finder/useFinderRootNavigation.ts')
  const toolbar = readSource('../src/components/features/knowledge/finder/useFinderToolbar.ts')
  const tree = readSource('../src/components/features/knowledge/finder/FinderTreeView.tsx')

  assert.match(rootNavigation, /columnKey: `space:\$\{row\.space\.spaceId\}`, type: 'enterColumn'/)
  assert.doesNotMatch(toolbar, /onSelectView\('columns'\)/)
  assert.match(tree, /<NewFolderRow/)
  assert.match(tree, /createFolderColumnKey/)
  const sidebar = readSource('../src/components/features/knowledge/finder/FinderTreeSidebar.tsx')
  assert.match(sidebar, /setExpandedSpaces\(\(current\) => new Set\(\[\.\.\.current, selectedSpaceId\]\)\)/)
})

test('root navigation keeps the selected Finder view and sort', () => {
  const navigation = readSource('../src/components/features/knowledge/finder/useFinderRootNavigation.ts')
  const documents = readSource('../src/components/features/knowledge/finder/DocumentsFinder.tsx')

  assert.match(navigation, /for \(const key of \['view', 'sort'\]\)/)
  assert.match(navigation, /withFinderQuery\('\/knowledge-base\/agents', search\)/)
  assert.match(documents, /const \{ pathname, search \} = useLocation\(\)/)
  assert.match(documents, /navigate, orgScope, search/)
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
