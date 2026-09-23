import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import { finderRootGroups } from '../src/components/features/knowledge/finder/FinderRootColumn'
import { agentDocumentsSpaceDisplayName } from '../src/components/features/knowledge/finder/agent-space-name'
import { buildFinderToolbarActions } from '../src/components/features/knowledge/finder/finder-toolbar-actions'
import { finderRouteColumns } from '../src/components/features/knowledge/finder/finder-route-columns'
import { migrateStoredFinderView } from '../src/components/features/knowledge/finder/finder-view'

/**
 * The root column and the toolbar that sits over it (browser-ui.md §3, §6,
 * overview's root model).
 *
 * The order of the root is a decision the owner made, and an empty group that
 * still draws its separator is the "heading for nothing" the model rules out.
 * The toolbar cases are Rule zero's: every action the navy sidebar and the old
 * header carried has somewhere to be.
 */

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const space = (overrides: Partial<KnowledgeRootSpace> & { spaceId: string; name: string }): KnowledgeRootSpace => ({
  canManageAccess: false,
  canWrite: true,
  ownerAgentId: null,
  projectId: '00000000-0000-0000-0000-000000000001',
  projectName: null,
  updatedAt: '2026-09-16T00:00:00.000Z',
  visibility: 'private',
  writeRestricted: false,
  ...overrides,
})

const root = (overrides: Partial<KnowledgeRoot> = {}): KnowledgeRoot => ({
  agentHomes: [],
  agentHomesTruncated: false,
  myDocuments: space({ name: 'My Docs', spaceId: 'me' }),
  projects: [],
  shared: [],
  sharedTruncated: false,
  sharedWithMeCount: 0,
  ...overrides,
})

test('phone Knowledge routes never stack the root picker over their detail column', () => {
  assert.deepEqual(
    finderRouteColumns({
      agentsColumn: null,
      columns: ['root', 'detail'],
      folderCount: 1,
      orgScope: true,
      pathname: '/knowledge-base',
      rootColumn: 'root',
      single: true,
      slots: ['root', 'depth:0'],
      virtualColumnKey: null,
    }),
    { columns: ['root'], slots: ['root'] },
  )
  assert.deepEqual(
    finderRouteColumns({
      agentsColumn: null,
      columns: ['root', 'detail'],
      folderCount: 1,
      orgScope: true,
      pathname: '/knowledge-base/spaces/space-a',
      rootColumn: 'root',
      single: true,
      slots: ['root', 'depth:0'],
      virtualColumnKey: null,
    }),
    { columns: ['detail'], slots: ['depth:0'] },
  )
  assert.deepEqual(
    finderRouteColumns({
      agentsColumn: null,
      columns: ['root', 'detail'],
      folderCount: 1,
      orgScope: true,
      pathname: '/knowledge-base',
      rootColumn: 'root',
      single: false,
      slots: ['root', 'depth:0'],
      virtualColumnKey: null,
    }),
    { columns: ['root', 'detail'], slots: ['root', 'depth:0'] },
  )
  assert.deepEqual(
    finderRouteColumns({
      agentsColumn: null,
      columns: ['detail'],
      folderCount: 1,
      orgScope: false,
      pathname: '/projects/project-a',
      rootColumn: 'root',
      single: true,
      slots: ['depth:0'],
      virtualColumnKey: null,
    }),
    { columns: ['detail'], slots: ['depth:0'] },
  )
})

test('the first group is continuous: virtual folders, My Documents and projects, no hairline', () => {
  const groups = finderRootGroups(root({
    projects: [{ projectId: 'p1', projectName: 'Apollo', space: space({ name: 'Apollo', spaceId: 's-apollo' }) }],
    shared: [space({ name: 'Marketing', spaceId: 's-mkt' })],
  }))

  assert.deepEqual(groups.map((group) => group.rows.map((row) => row.kind)), [
    ['latest', 'shared-with-me', 'space', 'space', 'agents'],
    ['space'],
  ])
  // My Documents always follows the two virtual rows, before any project: it
  // is the only folder every person has.
  assert.equal(groups[0]?.rows[2]?.id, 'me')
  assert.equal(groups[0]?.label, undefined)
})

test('every project row is its Documents folder — the read provisions, so none opens onto nothing', () => {
  const groups = finderRootGroups(root({
    projects: [{ projectId: 'p1', projectName: 'Apollo', space: space({ name: 'Project Documents', spaceId: 's-apollo' }) }],
  }))
  const row = groups[0]?.rows[3]
  assert.equal(row?.kind, 'space')
  assert.equal(row?.id, 's-apollo')
  // The `project-unopened` row kind is gone with the nullable space: a row
  // whose first click had to create its folder was a doorway to a write.
  const source = readSource('../src/components/features/knowledge/finder/FinderRootColumn.tsx')
  assert.doesNotMatch(source, /project-unopened/)
})

test('agent homes sit behind one Agents doorway instead of consuming root rows', () => {
  const groups = finderRootGroups(root({
    agentHomes: [
      space({ name: 'Ada — Documents', ownerAgentId: 'a-ada', spaceId: 's-ada' }),
    ],
    shared: [
      space({ name: 'Marketing', spaceId: 's-mkt' }),
    ],
  }))

  assert.deepEqual(groups.flatMap((group) => group.rows).filter((row) => row.kind === 'agents'), [
    { id: 'virtual:agents', kind: 'agents' },
  ])
  assert.equal(groups.flatMap((group) => group.rows).some((row) => row.id === 's-ada'), false)
  assert.deepEqual(groups[1]?.rows.map((row) => row.id), ['s-mkt'])
})

test('an agent home displays as the agent’s name, without the space’s suffix', () => {
  // `ensureAgentDocsSpace` names the space `${agentName} — Documents`; under
  // a label that already says Agents the suffix is furniture. Display-only —
  // the space keeps its name.
  assert.equal(agentDocumentsSpaceDisplayName('Ada — Documents'), 'Ada')
  // Only a trailing suffix strips: a name that carries the phrase mid-string
  // is kept whole, as is a space somebody renamed by hand.
  assert.equal(agentDocumentsSpaceDisplayName('Ada — Documents — Drafts'), 'Ada — Documents — Drafts')
  assert.equal(agentDocumentsSpaceDisplayName('Research'), 'Research')
})

test('an empty group is omitted, and takes its separator with it', () => {
  const groups = finderRootGroups(root())
  assert.deepEqual(groups.map((group) => group.rows.length), [4, 0])
  // The column renders only the non-empty ones, so a hairline never floats
  // over nothing.
  assert.deepEqual(groups.filter((group) => group.rows.length > 0).length, 1)
})

test('Dashboards is not a row here — it has its own home now', () => {
  // It carried an interim row while its only doorway was the navy sidebar this
  // replaces. It is now a project section (`/projects/:projectId/dashboards`)
  // and the global `/dashboards` route is gone, so a row here would point at a
  // 404 — the opposite of the rule it was added for.
  const source = readSource('../src/components/features/knowledge/finder/FinderRootColumn.tsx')
  assert.doesNotMatch(source, /kind: 'dashboards'/)
  assert.doesNotMatch(source, /'\/dashboards'/)
  const router = readSource('../src/router.tsx')
  assert.doesNotMatch(router, /path: '\/dashboards'/)
})

test('every header action the old sidebar and header carried has a home', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 3,
    canManageSpace: true,
    canWrite: true,
    isRootColumn: false,
    isVirtualColumn: false,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: true,
    sort: 'name',
    view: 'columns',
  })

  const ids = actions.map((action) => action.id)
  // `open-agent` is deliberately absent: the agent doorway moved out of the
  // global toolbar into the agent documents column's own header
  // (buildAgentOpenAction) — one doorway, on the column it belongs to.
  assert.deepEqual(ids, [
    'new', 'sort', 'view', 'needs-review', 'sharing-settings',
  ])

  // Folder, document and upload are one question with three answers, so they
  // are three items of one New menu rather than two buttons plus a menu.
  const create = actions.find((action) => action.id === 'new')
  assert.equal(create?.kind, 'menu')
  assert.deepEqual(
    create?.kind === 'menu' ? create.items.map((item) => item.label) : [],
    ['Folder', 'Document', 'Upload…'],
  )
})

test('exactly one action is primary, and it is the creation', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 0,
    canManageSpace: true,
    canWrite: true,
    isRootColumn: false,
    isVirtualColumn: false,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: true,
    sort: 'name',
    view: 'columns',
  })
  assert.deepEqual(actions.filter((action) => action.primary).map((action) => action.id), ['new'])
})

test('the root column names creation as a space, not a folder', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 0,
    canManageSpace: false,
    canWrite: false,
    isRootColumn: true,
    isVirtualColumn: false,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: true,
    sort: 'name',
    view: 'columns',
  })
  // The root has no space to create a folder *in*, so the one New menu
  // offers exactly one answer there — a space, which needs a visibility
  // choice and therefore an ellipsis.
  const create = actions.find((action) => action.id === 'new')
  assert.equal(create?.kind, 'menu')
  assert.deepEqual(
    create?.kind === 'menu' ? create.items.map((item) => item.label) : [],
    ['Space…'],
  )
  assert.equal(actions.find((action) => action.id === 'new-file'), undefined)
})

test('Sort is disabled, with a reason, in a virtual folder', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 0,
    canManageSpace: false,
    canWrite: true,
    isRootColumn: false,
    isVirtualColumn: true,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: true,
    sort: 'modified-desc',
    view: 'columns',
  })
  const sort = actions.find((action) => action.id === 'sort')
  assert.equal(sort?.disabled, true)
  assert.equal(sort?.title, 'Latest and Shared with me are ordered by time')
  // Latest is not a folder you write into.
  assert.equal(actions.find((action) => action.id === 'new-file'), undefined)
})

test('the View action is absent on a phone, not disabled', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 0,
    canManageSpace: false,
    canWrite: true,
    isRootColumn: false,
    isVirtualColumn: false,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: false,
    sort: 'name',
    view: 'columns',
  })
  assert.equal(actions.find((action) => action.id === 'view'), undefined)
})

test('a stored view mode from the old vocabulary still means what it meant', () => {
  assert.equal(migrateStoredFinderView('column'), 'columns')
  assert.equal(migrateStoredFinderView('full'), 'list')
  assert.equal(migrateStoredFinderView('tree'), 'tree')
  assert.equal(migrateStoredFinderView('columns'), 'columns')
  assert.equal(migrateStoredFinderView(null), 'columns')
  assert.equal(migrateStoredFinderView('nonsense'), 'columns')
})

test('the browser paints tokens, never a literal white', () => {
  // The look survives midnight and High Contrast only because nothing in
  // these files spells a colour.
  for (const file of [
    '../src/components/features/knowledge/finder/FinderRow.tsx',
    '../src/components/features/knowledge/finder/FinderRootColumn.tsx',
    '../src/components/features/knowledge/finder/FinderFolderColumn.tsx',
    '../src/components/features/knowledge/finder/DocumentsFinder.tsx',
    '../src/components/features/knowledge/finder/FinderStatusBar.tsx',
  ]) {
    const source = readSource(file)
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${file} carries a raw hex colour`)
    assert.doesNotMatch(
      source,
      /\b(?:bg|text|border)-(?:white|black|slate|gray|grey|zinc|neutral|stone|blue|red|green|amber|yellow)-/,
      `${file} carries a Tailwind palette colour`,
    )
  }
})
