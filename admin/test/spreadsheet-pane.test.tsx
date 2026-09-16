import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import test from 'node:test'

import { JSDOM } from 'jsdom'

// Vite's asset handling, as node hooks: `SpreadsheetPane` pulls in two
// stylesheets and `@ironcalc/wasm/wasm_bg.wasm?url`, none of which node can
// resolve. Registered before the dynamic imports below, which is why those
// imports are dynamic.
register('./support/asset-stub-hooks.mjs', import.meta.url)

const require = createRequire(import.meta.url)

// ── jsdom, with the two things IronCalc needs that jsdom does not have ───────
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/',
})
const { window } = dom

// jsdom has no canvas implementation at all — `getContext` throws "not
// implemented". IronCalc's `WorksheetCanvas` takes a 2d context in its
// constructor and then only calls drawing methods on it, so a recording no-op
// is enough to prove the widget mounts and paints without asserting pixels.
// (IronCalc's own vitest setup mocks it the same way.)
const CANVAS_METHODS = [
  'arc', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'createLinearGradient',
  'drawImage', 'fill', 'fillRect', 'fillText', 'lineTo', 'measureText', 'moveTo', 'putImageData',
  'quadraticCurveTo', 'rect', 'resetTransform', 'restore', 'rotate', 'save', 'scale',
  'setLineDash', 'setTransform', 'stroke', 'strokeRect', 'strokeText', 'transform', 'translate',
]
const fakeContext = (): unknown => {
  const context: Record<string, unknown> = {
    canvas: null,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    measureText: () => ({ width: 10 }),
  }
  for (const name of CANVAS_METHODS) context[name] ??= () => undefined
  return context
}
window.HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never

// jsdom implements neither, and both are constructed during the widget's mount.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver
window.matchMedia ??= ((query: string) => ({
  addEventListener: () => undefined,
  addListener: () => undefined,
  dispatchEvent: () => false,
  matches: false,
  media: query,
  onchange: null,
  removeEventListener: () => undefined,
  removeListener: () => undefined,
})) as never

// The admin's suites share one process (`--experimental-test-isolation=none`),
// so a DOM installed on `globalThis` outlives this file unless it is put back.
// The list is deliberately the minimum React and IronCalc need: `Event`,
// `CustomEvent` and `localStorage` are pointedly NOT among them, because
// replacing them made four unrelated suites fail — jsdom's `CustomEvent` is not
// an instance of node's `Event`, and a jsdom `localStorage` is not the one a
// persisted-gate test wrote to.
const globalAny = globalThis as Record<string, unknown>
const INSTALLED = [
  'CSS', 'Element', 'HTMLCanvasElement', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'MutationObserver', 'Node', 'ResizeObserver',
  'SVGElement', 'document', 'getComputedStyle', 'matchMedia', 'navigator',
  'requestAnimationFrame', 'cancelAnimationFrame', 'window',
] as const

const previous = new Map<string, PropertyDescriptor | undefined>()
const install = (key: string, value: unknown): void => {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  // `globalThis.navigator` is a getter-only accessor on Node 24, so every entry
  // is defined rather than assigned.
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
}

for (const key of INSTALLED) {
  if (key === 'requestAnimationFrame') {
    install(key, (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number)
    continue
  }
  if (key === 'cancelAnimationFrame') {
    install(key, (handle: number) => clearTimeout(handle))
    continue
  }
  install(key, (window as unknown as Record<string, unknown>)[key])
}
globalAny.IS_REACT_ACT_ENVIRONMENT = true

test.after(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalAny[key]
  }
  delete globalAny.IS_REACT_ACT_ENVIRONMENT
  window.close()
})

// ── the modules under test, imported after the hooks are registered ──────────
const [
  React,
  { act, createRoot },
  bridgeModule,
  themeModule,
  geometryModule,
  findModule,
  engineModule,
  actionBarModule,
  workspaceActionsModule,
  fileNodeModule,
  wasmModule,
] = await Promise.all([
  import('react'),
  import('react-dom/client').then(async (client) => ({
    act: (await import('react')).act,
    createRoot: client.createRoot,
  })),
  import('../src/components/features/knowledge/spreadsheet/spreadsheet-model-bridge'),
  import('../src/components/features/knowledge/spreadsheet/spreadsheet-theme'),
  import('../src/components/features/knowledge/spreadsheet/spreadsheet-geometry'),
  import('../src/components/features/knowledge/spreadsheet/spreadsheet-find'),
  import('../src/components/features/knowledge/spreadsheet/workbook-engine'),
  import('../src/components/features/knowledge/spreadsheet/SpreadsheetActionBar'),
  import('../src/components/features/knowledge/knowledge-workspace-actions'),
  import('../src/components/features/knowledge/FileNodeViewer'),
  import('@ironcalc/wasm'),
])

const { attachModelBridge, intentFromCall, isEmptyFlush, mutatingMethodNames } = bridgeModule
const { SPREADSHEET_THEME_KEYS, spreadsheetThemeVariables } = themeModule
const { HEADER_COLUMN_WIDTH, HEADER_ROW_HEIGHT, cellRect } = geometryModule
const { buildMatcher, findInModel } = findModule
const { buildWorkbook, encodeBase64 } = engineModule
const { SpreadsheetActionBar } = actionBarModule
const { buildKnowledgeWorkspaceActions } = workspaceActionsModule
const { isSpreadsheetSourceFilename } = fileNodeModule

// The published 0.8.4 wasm, instantiated once for the whole file.
const wasm = wasmModule as unknown as {
  Model: new (name: string, locale: string, timezone: string, language: string) => never
  initSync: (input: { module: Buffer }) => void
}
wasm.initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) })

type IronModel = import('@ironcalc/wasm').Model

const newModel = (): IronModel =>
  new wasm.Model('Test', 'en', 'UTC', 'en') as unknown as IronModel

// The checked-in fixture: a six-row workbook whose B6 is `=SUM(B2:B5)`. Built by
// `createNodeModel(...).toBytes()`, which is what Phase 2's bootstrap serves.
const FIXTURE = readFileSync(resolvePath(import.meta.dirname, 'fixtures/q3-forecast.icalc'))

const fixtureBootstrap = () => ({
  batches: [],
  engineVersion: '0.8.3',
  headSeq: 0,
  pageId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  sheets: [{ color: null, hidden: false, index: 0, name: 'Sheet1' }],
  snapshot: { bytes: encodeBase64(new Uint8Array(FIXTURE)), seq: 0 },
  title: 'Q3 Forecast',
  viewer: {
    actor: {
      color: '#2563eb',
      displayName: 'Taylor',
      id: '00000000-0000-4000-8000-000000000105',
      type: 'user' as const,
    },
    canWrite: true,
  },
})

// ── the bridge ───────────────────────────────────────────────────────────────

test('the bridge records every mutating call as an intent and drains one batch', async () => {
  const model = newModel()
  const flushes: import('../src/components/features/knowledge/spreadsheet/spreadsheet-model-bridge').BridgeFlush[] = []
  const presence: unknown[] = []
  const bridge = attachModelBridge(model, {
    onFlush: (flush) => flushes.push(flush),
    onPresence: (frame) => presence.push(frame),
  })

  model.setUserInput(0, 1, 1, 'Region')
  model.setUserInput(0, 2, 1, '120')
  model.insertRows(0, 2, 1)
  model.evaluate()
  bridge.flushNow()

  assert.equal(flushes.length, 1, 'one microtask, one batch')
  const flush = flushes[0]!
  assert.deepEqual(
    flush.calls.map((call) => call.method),
    ['setUserInput', 'setUserInput', 'insertRows'],
  )
  assert.deepEqual(flush.intents, [
    { column: 1, kind: 'setUserInput', row: 1, sheet: 0, value: 'Region' },
    { column: 1, kind: 'setUserInput', row: 2, sheet: 0, value: '120' },
    { count: 1, kind: 'insertRows', row: 2, sheet: 0 },
  ])
  assert.ok(flush.diffs.length > 1, 'a real batch carries more than the empty marker')

  // Selection is presence, never journal intent.
  model.setSelectedCell(4, 2)
  assert.equal(presence.length, 1)
  assert.deepEqual(presence[0], { column: 2, range: [4, 2, 4, 2], row: 4, sheet: 0 })

  bridge.detach()
})

test('an empty send queue is one 0x00 byte and is never submitted', () => {
  const model = newModel()
  model.flushSendQueue()
  const empty = model.flushSendQueue()

  // The measured fact this guard exists for (decisions.md §"Spike C/D" item 2).
  assert.deepEqual(Array.from(empty), [0x00])
  assert.equal(isEmptyFlush(empty), true)
  assert.equal(isEmptyFlush(new Uint8Array(0)), true)
  assert.equal(isEmptyFlush(new Uint8Array([0x01, 0x02])), false)

  const flushes: unknown[] = []
  const bridge = attachModelBridge(model, { onFlush: (flush) => flushes.push(flush) })
  bridge.flushNow()
  assert.equal(flushes.length, 0, 'a naive flush loop would burn a seq per microtask')
  bridge.detach()
})

test('a peer batch applies without echoing back into the local queue', () => {
  const model = newModel()
  model.setUserInput(0, 1, 1, '1')
  model.evaluate()
  model.flushSendQueue()

  const peer = (wasm as unknown as { Model: { from_bytes: (b: Uint8Array, l: string) => IronModel } })
    .Model.from_bytes(model.toBytes(), 'en')
  peer.flushSendQueue()
  peer.setUserInput(0, 1, 1, '999')
  peer.evaluate()
  const diffs = peer.flushSendQueue()

  const flushes: unknown[] = []
  const bridge = attachModelBridge(model, { onFlush: (flush) => flushes.push(flush) })
  bridge.applyExternal(diffs)

  assert.equal(model.getFormattedCellValue(0, 1, 1), '999')
  bridge.flushNow()
  assert.equal(flushes.length, 0, 'recording is suspended while foreign diffs land')
  bridge.detach()
})

test('wasm-bindgen plumbing is never shadowed, and undo/redo are', () => {
  const model = newModel()
  const recorded = mutatingMethodNames(model)

  assert.ok(recorded.length > 40, `expected the engine's mutators, got ${recorded.length}`)
  assert.ok(!recorded.some((name) => name.startsWith('_')), '__destroy_into_raw must stay intact')
  assert.ok(recorded.includes('undo') && recorded.includes('redo'))
  assert.ok(recorded.includes('setUserInput') && recorded.includes('deleteRows'))
  assert.ok(!recorded.includes('applyExternalDiffs') && !recorded.includes('flushSendQueue'))
  assert.ok(!recorded.includes('setSelectedCell'), 'selection is presence, not intent')

  // The instance keeps its pointer: the wrappers are own properties, not a fork.
  assert.equal(typeof (model as unknown as { __wbg_ptr: number }).__wbg_ptr, 'number')
})

test('a call the wire contract has no shape for records no intent', () => {
  assert.equal(intentFromCall({ args: ['Q4'], at: 0, method: 'renameSheet' }), null)
  assert.deepEqual(intentFromCall({ args: [], at: 0, method: 'undo' }), { kind: 'undo' })
  assert.deepEqual(
    intentFromCall({ args: [0, 3, 2, 5, 4], at: 0, method: 'rangeClearContents' }),
    { kind: 'rangeClearContents', range: { c0: 2, c1: 4, r0: 3, r1: 5 }, sheet: 0 },
  )
})

// ── the bootstrap ────────────────────────────────────────────────────────────

test('the bootstrap builds the fixture workbook and evaluates its formula', () => {
  const built = buildWorkbook(fixtureBootstrap() as never)

  assert.equal(built.appliedSeq, 0)
  assert.deepEqual(built.missingSeqs, [])
  assert.equal(built.model.getFormattedCellValue(0, 1, 1), 'Region')
  assert.equal(built.model.getFormattedCellValue(0, 6, 2), '445', '=SUM(B2:B5) evaluated')
})

test('the build stops at a batch whose diffs the fan-out dropped', () => {
  const bootstrap = fixtureBootstrap() as unknown as {
    batches: unknown[]
    snapshot: { seq: number }
  }
  bootstrap.batches = [
    { ...appliedBatch(1), diffs: null },
    { ...appliedBatch(2), diffs: 'AAA=' },
  ]
  const built = buildWorkbook(bootstrap as never)

  assert.deepEqual(built.missingSeqs, [1])
  assert.equal(built.appliedSeq, 0, 'never past a gap: a later seq would be a lie')
})

const appliedBatch = (seq: number) => ({
  actor: { color: '#2563eb', displayName: 'Taylor', id: 'u1', type: 'user' as const },
  baseSeq: seq - 1,
  batchId: '00000000-0000-4000-8000-00000000000a',
  cellCount: 1,
  clientOpId: '00000000-0000-4000-8000-00000000000b',
  createdAt: '2026-09-16T10:00:00.000Z',
  diffs: null,
  engineVersion: '0.8.3',
  pageId: '00000000-0000-4000-8000-000000000001',
  seq,
  sheetIndexes: [0],
  structuralKind: null,
})

// ── the theme ────────────────────────────────────────────────────────────────

test('the theme mapping answers every IronCalc variable from admin tokens', () => {
  const root = window.document.documentElement
  root.setAttribute(
    'style',
    [
      '--panel: rgb(17, 24, 39)',
      '--main: rgb(11, 15, 25)',
      '--tx: rgb(243, 244, 246)',
      '--tx2: rgb(209, 213, 219)',
      '--tx3: rgb(156, 163, 175)',
      '--sep: rgb(31, 41, 55)',
      '--accent: rgb(37, 99, 235)',
      'color-scheme: dark',
    ].join('; '),
  )
  const variables = spreadsheetThemeVariables(root)

  assert.equal(SPREADSHEET_THEME_KEYS.length, 58)
  for (const key of SPREADSHEET_THEME_KEYS) {
    assert.equal(typeof variables[key], 'string', `${key} is missing`)
    assert.notEqual(variables[key], '', `${key} resolved to nothing`)
    assert.ok(!variables[key].includes('var('), `${key} must be a literal, not ${variables[key]}`)
  }

  // The screenshot-only bug, pinned: `--palette-common-black` is the FOREGROUND.
  // Mapping it to the dark surface erases every toolbar icon, because they are
  // `currentColor` beneath it — and no assertion but this one catches it.
  assert.equal(variables['--palette-common-black'], 'rgb(243, 244, 246)')
  assert.equal(variables['--palette-common-white'], 'rgb(17, 24, 39)')
  assert.notEqual(variables['--palette-common-black'], variables['--palette-common-white'])

  root.removeAttribute('style')
})

// ── geometry, shared with Phase 3b's overlay ─────────────────────────────────

test('cellRect sums the engine’s own widths from the header origin', () => {
  const model = newModel()
  const first = cellRect(model, 0, 1, 1)

  assert.equal(first.left, HEADER_COLUMN_WIDTH)
  assert.equal(first.top, HEADER_ROW_HEIGHT)
  assert.equal(first.width, model.getColumnWidth(0, 1))

  const third = cellRect(model, 0, 1, 3)
  assert.equal(
    third.left,
    HEADER_COLUMN_WIDTH + model.getColumnWidth(0, 1) + model.getColumnWidth(0, 2),
  )
})

// ── find ─────────────────────────────────────────────────────────────────────

test('find walks the used range and honours the Sheets options', () => {
  const model = buildWorkbook(fixtureBootstrap() as never).model
  const sheets = [{ index: 0, name: 'Sheet1' }]
  const base = {
    inFormulas: false,
    matchCase: false,
    query: 'north',
    regex: false,
    scope: 'sheet' as const,
    wholeCell: false,
  }

  assert.deepEqual(
    findInModel(model, sheets, 0, base)?.map((match) => match.a1),
    ['A2'],
  )
  assert.deepEqual(findInModel(model, sheets, 0, { ...base, matchCase: true }), [])
  assert.deepEqual(
    findInModel(model, sheets, 0, { ...base, query: 'Nort', wholeCell: true }),
    [],
  )
  // The formula is invisible to a value search and visible to a formula search.
  assert.deepEqual(findInModel(model, sheets, 0, { ...base, query: 'SUM' }), [])
  assert.deepEqual(
    findInModel(model, sheets, 0, { ...base, inFormulas: true, query: 'SUM' })?.map((m) => m.a1),
    ['B6'],
  )
  // A half-typed regex is a typing state, not an error screen.
  assert.equal(buildMatcher({ ...base, query: '(', regex: true }), null)
  assert.equal(findInModel(model, sheets, 0, { ...base, query: '(', regex: true }), undefined)
})

// ── the doorways ─────────────────────────────────────────────────────────────

test('the space header offers New spreadsheet beside New page, and an import', () => {
  const actions = buildKnowledgeWorkspaceActions({
    agentDraftCount: 0,
    canManageSpace: true,
    canWrite: true,
    needsReviewOnly: false,
    onCreateFolder: () => undefined,
    onCreatePage: () => undefined,
    onCreateSpreadsheet: () => undefined,
    onImportSpreadsheet: () => undefined,
    onOpenAgent: () => undefined,
    onOpenSettings: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    selectedSpaceId: 'space-1',
    viewMode: 'column',
  })

  const ids = (actions ?? []).map((action) => action.id)
  assert.ok(ids.includes('new-spreadsheet'), 'Rule zero: a person must be able to make one')
  assert.ok(ids.includes('new-page'))

  const create = (actions ?? []).find((action) => action.id === 'new-spreadsheet')
  assert.equal(create?.label, 'New spreadsheet')
  assert.equal(create?.priority, 90, 'beside New page (100), not buried under More')

  const upload = (actions ?? []).find((action) => action.id === 'upload-file')
  assert.ok(upload && 'items' in upload)
  assert.deepEqual(
    (upload as { items: { id: string }[] }).items.map((item) => item.id),
    ['upload-file-node', 'import-spreadsheet'],
  )
})

test('a read-only viewer is offered neither doorway', () => {
  const actions = buildKnowledgeWorkspaceActions({
    agentDraftCount: 0,
    canManageSpace: false,
    canWrite: false,
    needsReviewOnly: false,
    onCreateFolder: () => undefined,
    onCreatePage: () => undefined,
    onCreateSpreadsheet: () => undefined,
    onImportSpreadsheet: () => undefined,
    onOpenAgent: () => undefined,
    onOpenSettings: () => undefined,
    onSelectView: () => undefined,
    onToggleNeedsReview: () => undefined,
    onUploadFile: () => undefined,
    selectedSpaceId: 'space-1',
    viewMode: 'column',
  })

  const ids = (actions ?? []).map((action) => action.id)
  assert.ok(!ids.includes('new-spreadsheet'))
  assert.ok(!ids.includes('upload-file'))
})

test('"Open as spreadsheet" is offered for the formats the engine can read', () => {
  assert.equal(isSpreadsheetSourceFilename('forecast.xlsx'), true)
  assert.equal(isSpreadsheetSourceFilename('export.CSV'), true)
  assert.equal(isSpreadsheetSourceFilename('export.tsv'), true)
  // `.xls` is refused on purpose: it and a corrupt zip produce the same engine
  // error, so offering the doorway would promise something that always fails.
  assert.equal(isSpreadsheetSourceFilename('legacy.xls'), false)
  assert.equal(isSpreadsheetSourceFilename('notes.md'), false)
  assert.equal(isSpreadsheetSourceFilename('README'), false)
})

// ── the pane's chrome, rendered ──────────────────────────────────────────────

const renderInto = async (element: React.ReactElement): Promise<HTMLElement> => {
  const host = window.document.createElement('div')
  window.document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return host as unknown as HTMLElement
}

test('the action bar carries what IronCalc lacks, and nothing it has', async () => {
  const chosen: string[] = []
  const host = await renderInto(
    React.createElement(SpreadsheetActionBar, {
      canWrite: true,
      onSelect: (id: string) => chosen.push(id),
      showFormatToggle: true,
    }),
  )

  const labels = [...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
  assert.deepEqual(labels, [
    'Sort…', 'Filter', 'Find & replace', 'Save version', 'History', 'Export', 'Hide Format', 'Fullscreen',
  ])
  // Formatting, the formula bar, the name box and the sheet tabs are IronCalc's;
  // the pane must never grow a second copy of one.
  assert.ok(!labels.some((label) => /bold|italic|font|formula|sheet tab/i.test(label ?? '')))

  const sort = host.querySelector('[data-testid="spreadsheet-action-sort"]') as HTMLButtonElement
  sort.click()
  assert.deepEqual(chosen, ['sort'])
})

test('a read-only viewer keeps the readable actions and loses the writing ones', async () => {
  const host = await renderInto(
    React.createElement(SpreadsheetActionBar, { canWrite: false, onSelect: () => undefined }),
  )
  const ids = [...host.querySelectorAll('button')].map((button) => button.getAttribute('data-testid'))

  assert.ok(!ids.includes('spreadsheet-action-sort'))
  assert.ok(!ids.includes('spreadsheet-action-save-version'))
  assert.ok(ids.includes('spreadsheet-action-history'), 'reading history is not writing')
  assert.ok(ids.includes('spreadsheet-action-export'))
  assert.ok(ids.includes('spreadsheet-action-find'))
})
