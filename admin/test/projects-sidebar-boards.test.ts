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
  // have the boards inside Board *closed* — plus the two section headers, which
  // go through the shared cookie-backed helper and the shell's starredCollapsed.
  assert.match(sidebar, /EXPANDED_PROJECT_IDS_COOKIE = 'projectsNavExpandedIds'/)
  assert.match(sidebar, /COLLAPSED_BOARD_PROJECT_IDS_COOKIE = 'projectsNavCollapsedBoardIds'/)
  assert.match(sidebar, /useCookieBackedSidebarSections\(/)
  for (const cookie of ['EXPANDED_PROJECT_IDS_COOKIE', 'COLLAPSED_BOARD_PROJECT_IDS_COOKIE']) {
    assert.match(sidebar, new RegExp(`getCookie\\(${cookie}\\)`), `${cookie} is read at mount`)
    assert.match(sidebar, new RegExp(`setCookie\\(\\s*${cookie}`), `${cookie} is written on change`)
  }
  // Both sets are pruned against the live project list, so neither store grows
  // without bound as projects come and go.
  assert.equal((sidebar.match(/retainExpandedProjectIds\(current, projects\)/g) ?? []).length, 2)
})

// On every layout that pins this sidebar the project header carries no board
// strip, so this list is the only doorway to a board that is not the project's
// default: it has to be open unless the reader closed it (AGENTS.md → "Rule
// zero"). The single column, which has no pinned sidebar, keeps the strip.
test('the boards under Board are open until the reader closes them', () => {
  assert.match(sidebar, /boardsExpanded=\{!collapsedBoardProjectIds\.has\(project\.id\)\}/)
})

test('the header board strip is the single column’s doorway and nowhere else', () => {
  const view = source('pages/project/ProjectView.tsx')
  assert.match(view, /const singleColumn = usePhoneLayout\(\)/)
  assert.match(view, /tab === 'board' && singleColumn \? \(\s*<BoardSwitcher/)
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
  const created = sidebar.slice(sidebar.indexOf('const handleBoardCreated = (board: BoardRecord)'))
  assert.match(created, /expandBoards\(boardCreateProjectId\)/)
  // A project's first board is its default, and a default board is spelled
  // without the param — the same link its row carries.
  assert.match(created, /board\.isDefault\s*\?\s*boardPath/)
  assert.match(created, /\$\{boardPath\}\?board=\$\{encodeURIComponent\(board\.id\)\}/)
  assert.ok(
    created.indexOf('expandBoards(') < created.indexOf('navigate('),
    'the list is opened before the navigation that lands in it',
  )
  assert.match(
    source('layouts/admin-shell/ProjectsNavDialogs.tsx'),
    /onCreated=\{onBoardCreated\}/,
  )
})

test('a project with no boards says so the way every other empty section does', () => {
  // One component for every empty sidebar section, so the sentence lands on the
  // row grid rather than in a box of its own — and one level deeper here,
  // where the board rows it stands in for would be. The board rows themselves
  // live in ProjectSectionRows.tsx since 06-F5, so the note stands beside them.
  const sectionRows = source('layouts/admin-shell/ProjectSectionRows.tsx')
  assert.match(sectionRows, /<SidebarEmptyNote indent="grandchild">There are no boards yet\.</)
  assert.match(sectionRows, /from '\.\/SidebarEmptyNote'/)
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
  // Those rows live in ProjectSectionRows.tsx, which owns them since 06-F5.
  const sectionRows = source('layouts/admin-shell/ProjectSectionRows.tsx')
  assert.match(sectionRows, /rowIcon\(section\.icon\)/)
  // A board carries its own glyph rather than the section's, because a board
  // can be given an emoji; `BOARD_ICON` is what it falls back to.
  assert.match(sectionRows, /<BoardIcon/)
  assert.match(
    source('components/features/projects/kanban/BoardIcon.tsx'),
    /icon=\{BOARD_ICON\}/,
  )
})

test('a board wears its own icon everywhere it is listed, and is given one where it is made', () => {
  // One component decides the glyph, so the sidebar row, the settings list and
  // the dialog that made the board cannot disagree about what it looks like.
  assert.match(
    source('layouts/admin-shell/ProjectSectionRows.tsx'),
    /<BoardIcon[\s\S]{0,120}iconEmoji=\{board\.iconEmoji\}/,
  )
  assert.match(
    source('pages/project/settings/BoardsSettingsSection.tsx'),
    /<BoardIconField[\s\S]{0,200}iconEmoji=\{board\.iconEmoji\}/,
  )
  assert.match(
    source('components/features/projects/kanban/BoardCreateDialog.tsx'),
    /<BoardIconField/,
  )
  // The header strip takes a plain string, so the emoji rides in front of the
  // name rather than being dropped there.
  assert.match(
    source('components/features/projects/kanban/BoardSwitcher.tsx'),
    /board\.iconEmoji \? `\$\{board\.iconEmoji\} \$\{board\.name\}` : board\.name/,
  )
  // Setting one is an administrative change to the project's shape, gated the
  // way every other board edit in that section is.
  assert.match(
    source('pages/project/settings/BoardsSettingsSection.tsx'),
    /canAdminister \? \(\s*<BoardIconField/,
  )
})

test('one board-create dialog serves both the sidebar and project settings', () => {
  assert.match(
    source('layouts/admin-shell/ProjectsNavDialogs.tsx'),
    /from '\.\.\/\.\.\/components\/features\/projects\/kanban\/BoardCreateDialog'/,
  )
  assert.match(
    source('pages/project/settings/BoardsSettingsSection.tsx'),
    /from '\.\.\/\.\.\/\.\.\/components\/features\/projects\/kanban\/BoardCreateDialog'/,
  )
})
