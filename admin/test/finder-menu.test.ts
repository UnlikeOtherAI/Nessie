import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFinderMenu,
  finderMenuLabel,
  sharingSurfaceFor,
  type FinderMenuCapabilities,
  type FinderMenuHandlers,
  type FinderMenuPage,
  type FinderMenuTarget,
} from '../src/components/features/knowledge/finder/finder-menu'
import { NEW_FILE_TYPES } from '../src/components/features/knowledge/finder/new-file-types'

/**
 * What a right-click offers
 * (docs/plans/2026-09-16-documents-finder-ui/menus-and-dialogs.md §2).
 *
 * `buildFinderMenu` is pure, so every row of the design's tables is a case
 * here rather than a screenshot. The one that carries the most weight is the
 * last group: whether "Sharing…" opens a surface that grants or one that
 * reads out is the whole of what the owner asked for, and getting it wrong in
 * either direction is a privacy defect — a grant control on a project's
 * documents would offer an edit the server refuses, and a read-out on his own
 * document would hide the feature he asked for.
 */

const selected: string[] = []

const handlers = (): FinderMenuHandlers => {
  const record = (name: string) => () => void selected.push(name)
  return {
    copyLink: record('copyLink'),
    download: record('download'),
    getInfo: record('getInfo'),
    moveTo: record('moveTo'),
    newDocument: record('newDocument'),
    newDocumentInside: record('newDocumentInside'),
    newFolder: record('newFolder'),
    newFolderInside: record('newFolderInside'),
    newSharedFolder: record('newSharedFolder'),
    open: record('open'),
    openAgent: record('openAgent'),
    openEditor: record('openEditor'),
    openProject: record('openProject'),
    openTicket: record('openTicket'),
    publish: record('publish'),
    refresh: record('refresh'),
    remove: record('remove'),
    removeShare: record('removeShare'),
    rename: record('rename'),
    retryIndexing: record('retryIndexing'),
    sharing: record('sharing'),
    showInFolder: record('showInFolder'),
    spaceSettings: record('spaceSettings'),
    uploadFiles: record('uploadFiles'),
    uploadVersion: record('uploadVersion'),
    versionHistory: record('versionHistory'),
  }
}

const caps = (overrides: Partial<FinderMenuCapabilities> = {}): FinderMenuCapabilities => ({
  accessMode: 'personal',
  actorIsPerson: true,
  canMoveTo: true,
  canManageAccess: true,
  canShare: true,
  canWrite: true,
  ...overrides,
})

const page = (overrides: Partial<FinderMenuPage> = {}): FinderMenuPage => ({
  id: 'p1',
  kind: 'document',
  status: 'published',
  title: 'Plan',
  ...overrides,
})

const labels = (target: FinderMenuTarget, capabilities = caps()): string[] =>
  buildFinderMenu({ capabilities, handlers: handlers(), target })
    .flatMap((item) => (item.kind === 'item' || item.kind === 'radio' ? [item.label] : []))

const ids = (target: FinderMenuTarget, capabilities = caps()): string[] =>
  buildFinderMenu({ capabilities, handlers: handlers(), target })
    .map((item) => (item.kind === 'separator' ? '—' : item.kind === 'heading' ? '#' : item.id))

// ── The sharing branch ──────────────────────────────────────────────────────

test('sharing grants only on the viewer’s own personal documents', () => {
  assert.equal(sharingSurfaceFor('personal', true), 'grant')
  // Every other container's audience is a fact about the container.
  assert.equal(sharingSurfaceFor('project', true), 'readout')
  assert.equal(sharingSurfaceFor('space', true), 'readout')
  assert.equal(sharingSurfaceFor('agent', true), 'readout')
  assert.equal(sharingSurfaceFor('shared_to_me', true), 'readout')
  // Somebody else's personal documents, reached as an organisation owner: the
  // mode says personal, but the viewer is not the person it belongs to.
  assert.equal(sharingSurfaceFor('personal', false), 'readout')
  // A surface that does not yet know what it is looking at must not show a
  // grant control it may have to take away.
  assert.equal(sharingSurfaceFor('unknown', true), 'readout')
})

test('the label is the same word whichever surface it opens', () => {
  const personal = labels({ kind: 'page', page: page(), virtual: false })
  const project = labels(
    { kind: 'page', page: page(), virtual: false },
    caps({ accessMode: 'project', canShare: false }),
  )
  assert.ok(personal.includes('Sharing…'))
  assert.ok(project.includes('Sharing…'))
})

// ── §2.1 a folder row ───────────────────────────────────────────────────────

test('a folder offers what you can do to a folder, and no version history', () => {
  assert.deepEqual(ids({ kind: 'page', page: page({ kind: 'folder', title: 'Contracts' }), virtual: false }), [
    'open', '—',
    'get-info', 'sharing', '—',
    'new-folder-inside', 'rename', 'move-to', '—',
    'copy-link', '—',
    'delete',
  ])
})

test('a task folder names its ticket, right under Get Info', () => {
  const list = ids({
    kind: 'page',
    page: page({ kind: 'folder', taskId: 't-1', title: 'KM-12 Rollout' }),
    virtual: false,
  })
  assert.equal(list[list.indexOf('get-info') + 1], 'open-ticket')
})

// ── §2.2 a document row ─────────────────────────────────────────────────────

test('a draft document offers Publish; a published one does not', () => {
  assert.ok(labels({ kind: 'page', page: page({ status: 'draft' }), virtual: false }).includes('Publish'))
  assert.ok(!labels({ kind: 'page', page: page(), virtual: false }).includes('Publish'))
})

test('Retry indexing appears only on a row whose pipeline actually failed', () => {
  const failed = page({ indexing: { stage: 'extract', state: 'failed' } })
  assert.ok(labels({ kind: 'page', page: failed, virtual: false }).includes('Retry indexing'))
  const pending = page({ indexing: { stage: 'embed', state: 'pending' } })
  assert.ok(!labels({ kind: 'page', page: pending, virtual: false }).includes('Retry indexing'))
})

// ── §2.3 a file row ─────────────────────────────────────────────────────────

test('a file’s menu is the order the browser suite pins (F-MENU-01)', () => {
  assert.deepEqual(labels({ kind: 'page', page: page({ kind: 'file', title: 'lease.pdf' }), virtual: false }), [
    'Open', 'Download',
    'Get Info', 'Sharing…', 'Version history', 'Upload new version…',
    'Rename', 'Move to…',
    'Copy link',
    'Delete…',
  ])
})

test('a read-only column offers what can be read and nothing that would 403', () => {
  const readOnly = caps({ accessMode: 'space', canShare: false, canWrite: false })
  const list = labels({ kind: 'page', page: page({ kind: 'file', title: 'brief.pdf' }), virtual: false }, readOnly)
  for (const absent of ['Rename', 'Move to…', 'Delete…', 'Upload new version…']) {
    assert.ok(!list.includes(absent), `${absent} must not be offered without write`)
  }
  assert.deepEqual(list, ['Open', 'Download', 'Get Info', 'Sharing…', 'Version history', 'Copy link'])
})

// ── §2.4 a virtual row, and the two grantee levels ──────────────────────────

test('a virtual row swaps the editor doorway for the way back to where it lives', () => {
  const list = labels({ kind: 'page', page: page(), virtual: true })
  assert.equal(list[1], 'Show in folder')
  assert.ok(!list.includes('Edit'))
  // New folder inside needs a position in a folder; a virtual row has none.
  assert.ok(!labels({ kind: 'page', page: page({ kind: 'folder' }), virtual: true })
    .includes('New folder inside'))
})

test('a view grantee may read and leave, and change nothing', () => {
  const list = labels({ kind: 'page', page: page({ access: 'view' }), virtual: true })
  assert.deepEqual(list, [
    'Open', 'Show in folder', 'Get Info', 'Sharing…', 'Version history', 'Copy link',
    'Remove from Shared with me',
  ])
})

test('an edit grantee may change content, but never the tree or the audience', () => {
  const list = labels({ kind: 'page', page: page({ access: 'edit' }), virtual: true })
  assert.ok(list.includes('Rename'))
  // The grant is a grant to change content. Publishing, moving, deleting and
  // re-sharing stay the owner's, so they are not offered at all.
  for (const absent of ['Publish', 'Move to…', 'Delete…']) {
    assert.ok(!list.includes(absent), `${absent} is the owner's, not the grantee's`)
  }
  assert.ok(list.includes('Remove from Shared with me'))
})

test('an edit grantee of a shared file may upload a new version', () => {
  const list = labels({
    kind: 'page',
    page: page({ access: 'edit', kind: 'file', title: 'lease.pdf' }),
    virtual: true,
  })
  assert.ok(list.includes('Upload new version…'))
  assert.ok(!labels({
    kind: 'page',
    page: page({ access: 'view', kind: 'file', title: 'lease.pdf' }),
    virtual: true,
  }).includes('Upload new version…'))
})

// ── §2.5 the empty background ───────────────────────────────────────────────

test('a writable folder’s background is the three ways to make something', () => {
  assert.deepEqual(labels({ column: 'folder', kind: 'background' }), [
    'New folder', 'New document', 'Upload files…', 'Get Info', 'Sharing…',
  ])
})

test('a read-only folder’s background reads out and offers nothing to create', () => {
  assert.deepEqual(
    labels({ column: 'folder', kind: 'background' }, caps({ canWrite: false })),
    ['Get Info', 'Sharing…'],
  )
})

test('the root creates a whole root folder; a virtual column can only be asked again', () => {
  assert.deepEqual(labels({ column: 'root', kind: 'background' }), ['New shared folder…', 'Refresh'])
  assert.deepEqual(labels({ column: 'virtual', kind: 'background' }), ['Refresh'])
})

// ── §2.6 root rows ──────────────────────────────────────────────────────────

test('a project row opens the project as well as its folder', () => {
  assert.deepEqual(labels({ kind: 'root-row', row: { projectId: 'proj', role: 'project' } }), [
    'Open', 'Open project', 'Get Info', 'Sharing…',
  ])
})

test('My Documents has no second doorway to open', () => {
  assert.deepEqual(labels({ kind: 'root-row', row: { role: 'personal' } }), [
    'Open', 'Get Info', 'Sharing…',
  ])
})

test('a shared folder a person may administer opens its settings, not a read-out', () => {
  assert.deepEqual(
    labels({ kind: 'root-row', row: { canManageAccess: true, canWrite: true, role: 'shared' } }),
    ['Open', 'Get Info', 'Sharing & settings…', 'Rename', 'Delete…'],
  )
  // A reader gets the read-out and nothing that would 403.
  assert.deepEqual(
    labels({ kind: 'root-row', row: { canManageAccess: false, canWrite: false, role: 'shared' } }),
    ['Open', 'Get Info', 'Sharing…'],
  )
})

test('Dashboards and a product view can only be opened', () => {
  assert.deepEqual(labels({ kind: 'root-row', row: { role: 'link' } }), ['Open'])
})

// ── §2.7 a multi-selection ──────────────────────────────────────────────────

test('a multi-selection offers only what is true of all of it', () => {
  const pages = [page({ id: 'a' }), page({ id: 'b', kind: 'file', title: 'x.pdf' })]
  assert.deepEqual(labels({ kind: 'selection', pages }), [
    'Get Info', 'Download', 'Move to…', 'Delete…',
  ])
})

test('a selection containing somebody else’s shared page cannot be moved or deleted', () => {
  const pages = [page({ id: 'a' }), page({ access: 'view', id: 'b' })]
  const list = labels({ kind: 'selection', pages })
  assert.ok(!list.some((label) => label.startsWith('Move')))
  assert.ok(!list.some((label) => label.startsWith('Delete')))
})

// ── Shape ───────────────────────────────────────────────────────────────────

test('no menu ever starts, ends or doubles a separator', () => {
  const targets: FinderMenuTarget[] = [
    { kind: 'page', page: page(), virtual: false },
    { kind: 'page', page: page({ access: 'view' }), virtual: true },
    { kind: 'page', page: page({ kind: 'folder' }), virtual: false },
    { kind: 'selection', pages: [page({ id: 'a' }), page({ id: 'b' })] },
    { kind: 'root-row', row: { role: 'personal' } },
    { column: 'folder', kind: 'background' },
  ]
  for (const target of targets) {
    for (const capabilities of [caps(), caps({ canShare: false, canWrite: false })]) {
      const shape = ids(target, capabilities)
      assert.notEqual(shape[0], '—', `leading rule: ${JSON.stringify(target.kind)}`)
      assert.notEqual(shape.at(-1), '—', `trailing rule: ${JSON.stringify(target.kind)}`)
      assert.ok(!shape.some((id, index) => id === '—' && shape[index + 1] === '—'), 'doubled rule')
    }
  }
})

test('the panel is named after what it acts on', () => {
  assert.equal(finderMenuLabel({ kind: 'page', page: page({ title: 'lease.pdf' }), virtual: false }),
    'Actions for lease.pdf')
  assert.equal(finderMenuLabel({ kind: 'selection', pages: [page({ id: 'a' }), page({ id: 'b' })] }),
    'Actions for 2 items')
  assert.equal(finderMenuLabel({ column: 'root', kind: 'background' }), 'Actions for Documents')
})

// ── The New-file registry ───────────────────────────────────────────────────

test('New offers exactly the kinds this build can actually make', () => {
  // Two, not three: the spreadsheet kind does not exist here, and a greyed
  // "coming soon" would be a promise this build cannot keep. A future
  // integrator adds one entry to NEW_FILE_TYPES and both call sites grow a row.
  assert.deepEqual(NEW_FILE_TYPES.map((type) => type.id), ['document', 'upload'])
  assert.deepEqual(NEW_FILE_TYPES.map((type) => type.label), ['Document', 'Upload…'])
})

test('a New kind invokes the doorway it names and nothing else', () => {
  const calls: string[] = []
  const context = {
    openCreate: (parentPageId: string | null) => void calls.push(`create:${parentPageId}`),
    openUploadPicker: () => void calls.push('upload'),
    parentPageId: 'folder-1',
    spaceId: 's1',
  }
  for (const type of NEW_FILE_TYPES) type.invoke(context)
  assert.deepEqual(calls, ['create:folder-1', 'upload'])
})
