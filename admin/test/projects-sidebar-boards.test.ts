import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ProjectRecord } from '../src/lib/api-client'
import {
  parseExpandedProjectIds,
  retainExpandedProjectIds,
  serializeExpandedProjectIds,
} from '../src/layouts/admin-shell/ProjectsSidebarNav'

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
  // The boards are rows under Board, one indent deeper than a section.
  assert.match(sidebar, /admin-sb-item sidebar-grandchild group/)
  assert.match(source('styles.css'), /\.admin-sb-item\.sidebar-grandchild\s*\{\s*padding-left: 44px;/)
  assert.match(source('styles.css'), /\.touch-sidebar \.admin-sb-item\.sidebar-grandchild/)

  // A board is a tab of the board screen, so it is `?board=` — and the default
  // board drops the param, exactly as `useTabParam` writes it.
  assert.match(sidebar, /board\.isDefault\s*\?\s*section\.to/)
  assert.match(sidebar, /\$\{section\.to\}\?board=\$\{encodeURIComponent\(board\.id\)\}/)

  // Its own disclosure, remembered separately from the project's sections.
  assert.match(sidebar, /aria-label=\{`\$\{boardsExpanded \? 'Collapse' : 'Expand'\} boards`\}/)
  assert.match(sidebar, /onToggleBoardsExpanded\(projectId\)/)

  // The "+" is a pop-up, not a trip to Settings, and it is offered only to
  // somebody whose click the server would not refuse.
  assert.match(sidebar, /aria-label="New board"/)
  assert.match(sidebar, /canAdministerProject \? \(/)
  assert.match(sidebar, /useCanAdministerProject\(projectId\)/)
  assert.match(sidebar, /<BoardCreateDialog/)
})

test('creating a board opens the board list that was closed and lands on the new board', () => {
  const created = sidebar.slice(sidebar.indexOf('onCreated={(board)'))
  assert.match(created, /expandBoards\(boardCreateProjectId\)/)
  // A project's first board is its default, and a default board is spelled
  // without the param — the same link its row carries.
  assert.match(created, /board\.isDefault\s*\?\s*boardPath/)
  assert.match(created, /\$\{boardPath\}\?board=\$\{encodeURIComponent\(board\.id\)\}/)
  assert.ok(
    created.indexOf('expandBoards(') < created.indexOf('navigate('),
    'the list is opened before the navigation that lands in it',
  )
})

test('a project with no boards says so the way every other empty section does', () => {
  // One component for every empty sidebar section, so the sentence lands on the
  // row grid rather than in a box of its own — and one level deeper here,
  // where the board rows it stands in for would be.
  assert.match(sidebar, /<SidebarEmptyNote indent="grandchild">There are no boards yet\.</)
  assert.match(sidebar, /from '\.\/SidebarEmptyNote'/)
  assert.match(
    source('layouts/admin-shell/SidebarProjectsSection.tsx'),
    /<SidebarEmptyNote indent="child">/,
  )
})

test('every project section row carries a glyph, and Board is plural', () => {
  const sections = source('navigation/project-sections.ts')

  // A list where only some rows have an icon is a list whose labels do not
  // line up, so the icon is part of the section rather than of the row.
  assert.match(sections, /icon: IconDefinition/)
  for (const id of ['overview', 'board', 'backlog', 'insights', 'docs', 'executors', 'settings']) {
    const entry = sections.slice(sections.indexOf(`id: '${id}'`) - 200, sections.indexOf(`id: '${id}'`))
    assert.match(entry, /icon: (fa[A-Za-z]+|BOARD_ICON)/, `${id} has no icon`)
  }
  assert.match(sections, /withCount\('Boards', assignedWorkCount\)/)
  assert.doesNotMatch(sections, /withCount\('Board', /)
  // Each board under the section wears the section's own glyph, the way every
  // channel wears the same `#`.
  assert.match(sidebar, /rowIcon\(BOARD_ICON\)/)
  assert.match(sidebar, /rowIcon\(section\.icon\)/)
})

test('one board-create dialog serves both the sidebar and project settings', () => {
  assert.match(sidebar, /from '\.\.\/\.\.\/components\/kanban\/BoardCreateDialog'/)
  assert.match(
    source('pages/project/settings/BoardsSettingsSection.tsx'),
    /from '\.\.\/\.\.\/\.\.\/components\/kanban\/BoardCreateDialog'/,
  )
})
