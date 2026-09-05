import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ProjectRecord } from '../src/lib/api-client'
import {
  parseExpandedProjectIds,
  retainExpandedProjectIds,
  serializeExpandedProjectIds,
} from '../src/layouts/admin-shell/projects-nav-expansion'

const source = (path: string): string => readFileSync(
  fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
  'utf8',
)

const projects = (ids: string[]): ProjectRecord[] => ids.map((id) => ({ id } as ProjectRecord))

const sidebar = source('layouts/admin-shell/ProjectsSidebarNav.tsx')

test('expanded project state accepts only serialized project ids', () => {
  assert.deepEqual([...parseExpandedProjectIds('["p-a", 7, "p-a", null]')], ['p-a'])
  assert.deepEqual([...parseExpandedProjectIds('not-json')], [])
  assert.deepEqual([...parseExpandedProjectIds('{"p-a":true}')], [])
  assert.deepEqual([...parseExpandedProjectIds(null)], [])
})

test('expanded project state removes deleted projects before persisting', () => {
  const retained = retainExpandedProjectIds(new Set(['p-a', 'gone', 'p-b']), projects(['p-a', 'p-b']))

  assert.deepEqual([...retained], ['p-a', 'p-b'])
  assert.equal(serializeExpandedProjectIds(retained), '["p-a","p-b"]')
})

test('every open/closed state of the Projects menu is written to a store that outlives the tab', () => {
  // Two id sets of its own — which projects have their sections open, and which
  // have the boards inside Board open — plus the two section headers, which go
  // through the shared cookie-backed helper and the shell's starredCollapsed.
  assert.match(sidebar, /EXPANDED_PROJECT_IDS_COOKIE = 'projectsNavExpandedIds'/)
  assert.match(sidebar, /EXPANDED_BOARD_PROJECT_IDS_COOKIE = 'projectsNavExpandedBoardIds'/)
  assert.match(sidebar, /useCookieBackedSidebarSections\(/)
  for (const cookie of ['EXPANDED_PROJECT_IDS_COOKIE', 'EXPANDED_BOARD_PROJECT_IDS_COOKIE']) {
    assert.match(sidebar, new RegExp(`getCookie\\(${cookie}\\)`), `${cookie} is read at mount`)
    assert.match(sidebar, new RegExp(`setCookie\\(\\s*${cookie}`), `${cookie} is written on change`)
  }
  // Both sets are pruned against the live project list, so neither store grows
  // without bound as projects come and go.
  assert.equal((sidebar.match(/retainExpandedProjectIds\(current, projects\)/g) ?? []).length, 2)
})

test('the Board section lists the project boards and creates one through a dialog', () => {
  // The per-project section/board rows moved to ProjectSectionRows.tsx,
  // rendered by ProjectsSidebarNav.tsx via ProjectRow.tsx (06-F5); the dialog
  // itself moved to ProjectsNavDialogs.tsx, mirroring SidebarDialogs.tsx.
  const sectionRows = source('layouts/admin-shell/ProjectSectionRows.tsx')
  const dialogs = source('layouts/admin-shell/ProjectsNavDialogs.tsx')

  // The boards are rows under Board, one indent deeper than a section.
  assert.match(sectionRows, /admin-sb-item sidebar-grandchild group/)
  assert.match(source('styles.css'), /\.admin-sb-item\.sidebar-grandchild\s*\{\s*padding-left: 44px;/)
  assert.match(source('styles.css'), /\.touch-sidebar \.admin-sb-item\.sidebar-grandchild/)

  // A board is a tab of the board screen, so it is `?board=` — and the default
  // board drops the param, exactly as `useTabParam` writes it.
  assert.match(sectionRows, /board\.isDefault\s*\?\s*section\.to/)
  assert.match(sectionRows, /\$\{section\.to\}\?board=\$\{encodeURIComponent\(board\.id\)\}/)

  // Its own disclosure, remembered separately from the project's sections.
  assert.match(sectionRows, /aria-label=\{`\$\{boardsExpanded \? 'Collapse' : 'Expand'\} boards`\}/)
  assert.match(sectionRows, /onToggleBoardsExpanded\(projectId\)/)

  // The "+" is a pop-up, not a trip to Settings, and it is offered only to
  // somebody whose click the server would not refuse.
  assert.match(sectionRows, /aria-label="New board"/)
  assert.match(sectionRows, /canAdministerProject \? \(/)
  assert.match(sectionRows, /useCanAdministerProject\(projectId\)/)
  assert.match(dialogs, /<BoardCreateDialog/)
})

test('creating a board opens the board list that was closed and lands on the new board', () => {
  // The navigation decision (expand, then land on the new board) stays in
  // ProjectsSidebarNav.tsx as `handleBoardCreated`, passed into
  // ProjectsNavDialogs.tsx as the `onBoardCreated` prop (06-F5).
  const created = sidebar.slice(sidebar.indexOf('const handleBoardCreated = (boardId: string)'))
  assert.match(created, /expandBoards\(boardCreateProjectId\)/)
  assert.match(created, /\/projects\/\$\{boardCreateProjectId\}\/board\?board=\$\{encodeURIComponent\(boardId\)\}/)
  assert.ok(
    created.indexOf('expandBoards(') < created.indexOf('navigate('),
    'the list is opened before the navigation that lands in it',
  )
  assert.match(
    source('layouts/admin-shell/ProjectsNavDialogs.tsx'),
    /onCreated=\{onBoardCreated\}/,
  )
})

test('one board-create dialog serves both the sidebar and project settings', () => {
  assert.match(
    source('layouts/admin-shell/ProjectsNavDialogs.tsx'),
    /from '\.\.\/\.\.\/components\/kanban\/BoardCreateDialog'/,
  )
  assert.match(
    source('pages/project/settings/BoardsSettingsSection.tsx'),
    /from '\.\.\/\.\.\/\.\.\/components\/kanban\/BoardCreateDialog'/,
  )
})
