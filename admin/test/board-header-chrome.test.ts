import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (path: string): string => readFileSync(
  fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
  'utf8',
)

const view = source('pages/project/ProjectView.tsx')
const boardTab = source('pages/project/ProjectBoardTab.tsx')
const chrome = source('pages/project/useBoardChrome.ts')
const kanban = source('components/features/projects/kanban/KanbanBoard.tsx')
const column = source('components/features/projects/kanban/KanbanColumn.tsx')

/**
 * The board screen is one row of chrome, not three.
 *
 * It used to be the project's name, then the board's name on a line of its
 * own, then a toolbar carrying a view strip and the assignee filter, and then
 * a collapsible Archived drawer at the foot of the board — four bands of
 * furniture around the only thing anybody came for. What is left is the
 * header: the board's own name, the filter, Configure, New task.
 */

test('the board names itself, and the project is not repeated above it', () => {
  // The project is one row up in the sidebar and one press back on a phone.
  assert.match(view, /title=\{onBoard \? board\?\.name : undefined\}/)
  assert.doesNotMatch(view, /subtitle=/, 'the board name was the subtitle; it is the title now')
})

test('the header row reads assignee, Configure, New task, left to right', () => {
  // Order is the array's, not the priority's — priority decides what survives
  // a narrow header, which is a different question.
  const ids = [...view.matchAll(/^\s{6}id: '([a-z-]+)',$/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['board-assignee', 'board-configure', 'new-task'])
  assert.match(view, /id: 'new-task',[\s\S]{0,160}?primary: true/)
})

test('the assignee filter is a control in the row, not a menu row in it', () => {
  // A picker with avatars and a search cannot be flattened into menu items,
  // so it is drawn by the screen and pinned: More has no rows to put it in.
  assert.match(view, /id: 'board-assignee',\s*\n\s*kind: 'custom',/)
  assert.match(view, /pinned: true,/)
  assert.match(view, /render: \(\) => \(\s*\n\s*<BoardAssigneeFilter/)
  // The single column has a title to fit in the same row, so there it is one
  // 44px mark and the name goes to the accessible name.
  assert.match(view, /compact=\{singleColumn\}/)
})

test('Configure carries the view, the archived toggle and Members', () => {
  for (const [id, label] of [
    ['view-cards', 'Cards'],
    ['view-lines', 'Lines'],
    ['show-archived', 'Show archived'],
    ['project-members', 'Members'],
  ]) {
    assert.match(view, new RegExp(`id: '${id}',\\s*\\n\\s*label: \`?'?${label}`), `${id} is a Configure row`)
  }
  // Checked rows, so the menu says which view is on and whether archived work
  // is shown — a menu that only fired would leave both unanswerable.
  assert.match(view, /checked: chrome\.view === 'cards'/)
  assert.match(view, /checked: chrome\.view === 'lines'/)
  assert.match(view, /checked: chrome\.showArchived/)
  // Board administration keeps its doorways, still only for somebody whose
  // click the server would not refuse.
  assert.match(view, /\.\.\.\(canAdminister/)
})

test('the board tab draws no toolbar of its own any more', () => {
  assert.doesNotMatch(boardTab, /<TabBar/, 'the view strip moved into Configure')
  assert.doesNotMatch(boardTab, /<BoardAssigneeFilter/, 'the filter moved into the header')
  // The source health strip stays: it is a status the board answers with, not
  // a control competing with the header.
  assert.match(boardTab, /<SourceStatusStrip/)
})

test('one piece of state behind the header and the board', () => {
  // Two components, one URL and one query cache — not a prop chain through
  // the page, and not two copies that can disagree.
  assert.match(view, /const chrome = useBoardChrome\(projectId, board\?\.id\)/)
  assert.match(boardTab, /const chrome = useBoardChrome\(projectId, board\?\.id\)/)
  // Above the `projectId` guard, with every other hook.
  assert.ok(
    view.indexOf('useBoardChrome(projectId') < view.indexOf('if (!projectId) return null'),
    'the hook runs before the guard, so hook order never depends on the URL',
  )
})

test('the board opens on cards, with archived work not shown', () => {
  assert.match(chrome, /useTabParam\('view', BOARD_VIEWS, DEFAULT_BOARD_VIEW\)/)
  assert.match(chrome, /useTabParam\('archived', ARCHIVED_STATES, 'hidden'\)/)
  assert.match(chrome, /showArchived: archived === 'shown'/)
  assert.match(kanban, /showArchived = false,/)
})

test('archived work is the last column, and nothing can be dropped in it', () => {
  // Appended after the real columns, so it is last and pages with them.
  assert.match(kanban, /if \(showArchived\) \{\s*\n\s*drawn\.push\(\{ archived: true/)
  assert.match(kanban, /droppable=\{false\}/)
  assert.match(kanban, /itemIds=\{\[\]\}/)
  // It is not one of `columns`, so no drag can resolve to it: the drop model
  // — `baseItems` and `findColumn` — is built from the real columns only,
  // while `drawnColumns` decides nothing but what is painted.
  assert.match(kanban, /for \(const column of columns\) map\[column\.id\]/)
  assert.match(kanban, /return columns\.find\(\(column\) => map\[column\.id\]\?\.includes\(id\)\)\?\.id/)
  assert.match(column, /useDroppable\(\{ disabled: !droppable, id: columnId \}\)/)
  assert.match(column, /data-kanban-dropzone=\{droppable \? columnId : undefined\}/)
})

test('the archived drawer under the board is gone', () => {
  assert.doesNotMatch(kanban, /Archived \(\{archived\.length\}\)/)
  assert.doesNotMatch(kanban, /setShowArchived/, 'the toggle is the header’s, not the board’s')
  // The cards themselves are unchanged — they moved, they were not rewritten.
  assert.match(kanban, /<ArchivedTaskCard/)
  assert.match(kanban, /No cancelled or failed work\./)
})
