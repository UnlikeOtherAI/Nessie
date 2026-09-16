import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import { finderRootGroups } from '../src/components/features/knowledge/finder/FinderRootColumn'
import { buildFinderToolbarActions } from '../src/components/features/knowledge/finder/finder-toolbar-actions'
import {
  migrateStoredFinderView,
} from '../src/components/features/knowledge/finder/finder-view'

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
  myDocuments: space({ name: 'My Docs', spaceId: 'me' }),
  projects: [],
  shared: [],
  sharedTruncated: false,
  sharedWithMeCount: 0,
  ...overrides,
})

test('the root is three groups: the virtual folders, mine, and the shared ones', () => {
  const groups = finderRootGroups(root({
    projects: [{ projectId: 'p1', projectName: 'Apollo', space: space({ name: 'Apollo', spaceId: 's-apollo' }) }],
    shared: [space({ name: 'Marketing', spaceId: 's-mkt' })],
  }))

  assert.deepEqual(groups.map((group) => group.map((row) => row.kind)), [
    ['latest', 'shared-with-me'],
    ['space', 'space'],
    ['space'],
  ])
  // My Documents is always the first row of the second group, before any
  // project: it is the only folder every person has.
  assert.equal(groups[1]?.[0]?.id, 'me')
})

test('a project whose folder has never been opened is still a row', () => {
  const groups = finderRootGroups(root({
    projects: [{ projectId: 'p1', projectName: 'Apollo', space: null }],
  }))
  const row = groups[1]?.[1]
  assert.equal(row?.kind, 'project-unopened')
  // `GET /root` writes no space for a project nobody has opened, and a
  // project a person belongs to that has no row is Rule zero's defect.
  assert.equal(row?.kind === 'project-unopened' ? row.projectName : null, 'Apollo')
})

test('an empty group is omitted, and takes its separator with it', () => {
  const groups = finderRootGroups(root())
  assert.deepEqual(groups.map((group) => group.length), [2, 1, 0])
  // The column renders only the non-empty ones, so a hairline never floats
  // over nothing.
  assert.deepEqual(groups.filter((group) => group.length > 0).length, 2)
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
    onOpenAgent: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    ownerAgentId: 'agent-1',
    showViewAction: true,
    sort: 'name',
    view: 'columns',
  })

  const ids = actions.map((action) => action.id)
  assert.deepEqual(ids, [
    'new', 'sort', 'view', 'needs-review', 'open-agent', 'sharing-settings',
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
    onOpenAgent: () => undefined,
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

test('the root column offers a whole root folder, not a folder inside one', () => {
  const actions = buildFinderToolbarActions({
    agentDraftCount: 0,
    canManageSpace: false,
    canWrite: false,
    isRootColumn: true,
    isVirtualColumn: false,
    needsReviewOnly: false,
    onCreateDocument: () => undefined,
    onCreateFolder: () => undefined,
    onOpenAgent: () => undefined,
    onOpenSettings: () => undefined,
    onSelectSort: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    showViewAction: true,
    sort: 'name',
    view: 'columns',
  })
  // The root has no folder to create anything *in*, so the one New menu
  // offers exactly one answer there — a whole root folder, which needs a
  // visibility choice and therefore an ellipsis.
  const create = actions.find((action) => action.id === 'new')
  assert.equal(create?.kind, 'menu')
  assert.deepEqual(
    create?.kind === 'menu' ? create.items.map((item) => item.label) : [],
    ['Folder…'],
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
    onOpenAgent: () => undefined,
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
    onOpenAgent: () => undefined,
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
  assert.equal(migrateStoredFinderView('tree'), 'list')
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
