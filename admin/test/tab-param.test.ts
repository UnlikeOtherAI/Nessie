import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

// One state model for every in-page tab strip (docs/navigation/overview.md §1, "Tab
// hosts"; plan §2.5 and §7). The tab lives in a URL search param written with
// `replace`, so it is linkable and refresh-safe and never a history entry.
// These cases pin the hook's three promises — validate, replace, preserve —
// and the source gate that stops a sixteenth strip reintroducing component
// state.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

type Harness = {
  dispose: () => Promise<void>
  react: typeof import('react')
  render: (element: unknown) => Promise<void>
}

const mountHarness = async (): Promise<Harness> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const react = await import('react')
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as typeof globalThis & { React: typeof react }).React = react

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  return {
    dispose: async () => {
      await react.act(async () => root.unmount())
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as Record<string, unknown>)[key]
      }
    },
    react,
    render: async (element: unknown) => {
      await react.act(async () => root.render(element as never))
    },
  }
}

const TABS = ['messages', 'files', 'agents'] as const

test('an unknown or absent tab reads as the fallback', async () => {
  const harness = await mountHarness()
  const { act, createElement: h } = harness.react
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { useTabParam } = await import('../src/navigation/useTabParam.js')

  const seen: string[] = []
  const Probe = () => {
    const [tab] = useTabParam('tab', TABS, 'messages')
    seen.push(tab)
    return null
  }

  const router = createMemoryRouter([{ path: '/c/:id', element: h(Probe) }], {
    // absent, a value outside the list, and a real one.
    initialEntries: ['/c/1', '/c/1?tab=nonsense', '/c/1?tab=files'],
    initialIndex: 0,
  })

  try {
    await harness.render(h(RouterProvider, { router }))
    assert.equal(seen.at(-1), 'messages')

    await act(async () => { await router.navigate(1) })
    assert.equal(seen.at(-1), 'messages', 'a hand-typed tab must not blank the panel')

    await act(async () => { await router.navigate(1) })
    assert.equal(seen.at(-1), 'files')
  } finally {
    await harness.dispose()
  }
})

test('selecting a tab replaces, keeps other params, and never grows history', async () => {
  const harness = await mountHarness()
  const { act, createElement: h } = harness.react
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { useTabParam } = await import('../src/navigation/useTabParam.js')

  let select: ((next: (typeof TABS)[number]) => void) | undefined
  const Probe = () => {
    const [, setTab] = useTabParam('tab', TABS, 'messages')
    select = setTab
    return null
  }

  const router = createMemoryRouter(
    [
      { path: '/before', element: h('p', null, 'Before') },
      { path: '/c/:id', element: h(Probe) },
    ],
    { initialEntries: ['/before', '/c/1?highlight=m7&view=column'], initialIndex: 1 },
  )

  try {
    await harness.render(h(RouterProvider, { router }))
    const entriesBefore = router.state.location.key

    await act(async () => { select?.('files') })
    const params = new URLSearchParams(router.state.location.search)
    assert.equal(params.get('tab'), 'files')
    // Every other param survives — a tab is not a new address.
    assert.equal(params.get('highlight'), 'm7')
    assert.equal(params.get('view'), 'column')
    assert.notEqual(router.state.location.key, entriesBefore, 'the location did change')

    // A second strip on the same page writes beside the first, not over it.
    await act(async () => { select?.('agents') })
    assert.equal(new URLSearchParams(router.state.location.search).get('tab'), 'agents')
    assert.equal(new URLSearchParams(router.state.location.search).get('view'), 'column')

    // Selecting the fallback clears the param rather than spelling the default.
    await act(async () => { select?.('messages') })
    assert.equal(new URLSearchParams(router.state.location.search).has('tab'), false)

    // Three tab changes, and Back still leaves the host: replace, not push.
    await act(async () => { await router.navigate(-1) })
    assert.equal(router.state.location.pathname, '/before')
  } finally {
    await harness.dispose()
  }
})

test('a tab change keeps the entry state the screen arrived with', async () => {
  const harness = await mountHarness()
  const { act, createElement: h } = harness.react
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')
  const { useTabParam } = await import('../src/navigation/useTabParam.js')

  let select: ((next: (typeof TABS)[number]) => void) | undefined
  const Probe = () => {
    const [, setTab] = useTabParam('tab', TABS, 'messages')
    select = setTab
    return null
  }

  const router = createMemoryRouter([{ path: '/c/:id', element: h(Probe) }], {
    initialEntries: [{ pathname: '/c/1', state: { returnTo: '/projects/p1' } }],
  })

  try {
    await harness.render(h(RouterProvider, { router }))
    await act(async () => { select?.('files') })
    assert.deepEqual(router.state.location.state, { returnTo: '/projects/p1' })
  } finally {
    await harness.dispose()
  }
})

test('a project section switch replaces and reconciles the view in place', async () => {
  const harness = await mountHarness()
  const { act, createElement: h, useRef, useState } = harness.react
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom')

  // The seven section routes render the same element, so React reconciles one
  // ProjectView across them: the switch swaps the section, it does not remount
  // the page. This stands in for that shape.
  let mounts = 0
  let bump: (() => void) | undefined
  const View = () => {
    const first = useRef(true)
    if (first.current) {
      first.current = false
      mounts += 1
    }
    const [count, setCount] = useState(0)
    bump = () => setCount((value) => value + 1)
    return h('p', null, String(count))
  }
  const sections = ['', '/board', '/backlog', '/insights', '/docs', '/executors', '/settings']
  const router = createMemoryRouter(
    [
      { path: '/projects', element: h('p', null, 'Projects') },
      ...sections.map((section) => ({ path: `/projects/:projectId${section}`, element: h(View) })),
    ],
    { initialEntries: ['/projects', '/projects/p1'], initialIndex: 1 },
  )

  try {
    await harness.render(h(RouterProvider, { router }))
    assert.equal(mounts, 1)
    await act(async () => { bump?.() })

    for (const section of sections.slice(1)) {
      await act(async () => { await router.navigate(`/projects/p1${section}`, { replace: true }) })
    }
    assert.equal(router.state.location.pathname, '/projects/p1/settings')
    // One mount across all seven sections, and its state survived every switch.
    assert.equal(mounts, 1)

    // Six section switches, and Back leaves the project rather than walking them.
    await act(async () => { await router.navigate(-1) })
    assert.equal(router.state.location.pathname, '/projects')
  } finally {
    await harness.dispose()
  }
})

test("the project header's section switch is written with replace", () => {
  const view = readSource('../src/pages/project/ProjectView.tsx')
  assert.match(view, /onSelect: \(\) => void navigate\(item\.to, \{ replace: true \}\)/)
})

// ─── The source gate ────────────────────────────────────────────────────────

/**
 * Files that render a `<TabBar` but keep its value in `useState`. It only ever
 * shrinks. Every entry is a form field rather than a section of a screen: the
 * answer is submitted and thrown away, so a URL param would outlive the control
 * that asked, survive its cancellation, and collide with the tab of the page it
 * sits on. The two dialogs cannot use one because the param would outlast the
 * dialog; the approval gate cannot because a feed renders one gate per pending
 * approval, and a single param has no way to hold N independent answers. Each
 * says so where it stands.
 */
/** Every `<TabBar …/>` element in a file, as its own attribute text. */
const tabBarElements = (content: string): string[] => {
  const elements: string[] = []
  let cursor = content.indexOf('<TabBar')
  while (cursor >= 0) {
    const end = content.indexOf('/>', cursor)
    elements.push(content.slice(cursor, end < 0 ? content.length : end))
    cursor = content.indexOf('<TabBar', cursor + 1)
  }
  return elements
}

// Transient overlays, where the strip picks a branch of a form the person is
// filling in right now rather than a view they might link someone to. A URL
// param would outlive the dialog it belongs to and address nothing once it
// closed. Everything that survives a reload stays on `useTabParam`.
const COMPONENT_STATE_ALLOWLIST = [
  'admin/src/components/features/apps/AppConnectDialog.tsx',
  'admin/src/components/features/apps/AppSecretDialog.tsx',
  'admin/src/components/features/channels/RunApprovalGate.tsx',
  'admin/src/layouts/admin-shell/CreateWorkspaceDialog.tsx',
]

test('no tab strip keeps its selection in component state', () => {
  const tracked = execSync("git ls-files 'admin/src/*.tsx' 'admin/src/*.ts'", {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const hosts: string[] = []
  const violations: string[] = []
  for (const file of tracked) {
    const content = readFileSync(`${repoRoot}/${file}`, 'utf8')
    if (!content.includes('<TabBar')) continue
    if (file.endsWith('primitives/TabBar.tsx')) continue
    hosts.push(file)
    if (COMPONENT_STATE_ALLOWLIST.includes(file)) continue

    // The strip's value is either owned here through the one hook, or handed
    // in as a prop by the host that owns it. What it must never be is a
    // useState in the same file. Only the TabBar element's own `value` counts —
    // a <select> beside it is a form field, not a tab.
    for (const start of tabBarElements(content)) {
      const identifier = /value=\{([A-Za-z0-9_]+)/.exec(start)?.[1]
      if (!identifier) continue
      const declared = new RegExp(`const \\[${identifier}, [A-Za-z0-9_]+\\] = useState`)
      if (declared.test(content)) violations.push(`${file} (${identifier})`)
    }
  }

  assert.ok(hosts.length >= 12, `expected the strips to be found, saw ${hosts.length}`)
  assert.deepEqual(
    violations,
    [],
    'a tab strip must read useTabParam (or a prop from the host that does), never useState',
  )
})

test('every tab host resolves its tab through the one hook', () => {
  // The hosts, and the param each writes. Adding a strip means adding its row:
  // that is what keeps "one model" true rather than aspirational.
  const hosts: ReadonlyArray<readonly [string, string]> = [
    ['../src/pages/channels/useChannelTab.ts', 'tab'],
    ['../src/pages/AppDetailPage.tsx', 'tab'],
    ['../src/pages/AppsPage.tsx', 'filter'],
    ['../src/pages/SearchPage.tsx', 'mode'],
    ['../src/pages/ToolsPage.tsx', 'source'],
    ['../src/pages/settings/AppearancePage.tsx', 'tab'],
    ['../src/pages/triggers/useTriggersPageState.ts', 'status'],
    ['../src/components/features/agents/AgentDetailTabs.tsx', 'agentTab'],
    ['../src/components/features/agents/AgentsList.tsx', 'scope'],
    ['../src/components/features/browser-cloud/AgentScreenViewer.tsx', 'browserTab'],
    ['../src/components/features/executors/ExecutorDetailPanels.tsx', 'tab'],
    ['../src/components/features/integrations/DeepWaterResearchPanel.tsx', 'research'],
    ['../src/components/features/knowledge/KnowledgeWorkspace.tsx', 'view'],
  ]

  for (const [file, param] of hosts) {
    const content = readSource(file)
    assert.match(content, /useTabParam/, `${file} must resolve its tab through useTabParam`)
    assert.ok(
      content.includes(`useTabParam(\n    '${param}'`) || content.includes(`useTabParam('${param}'`),
      `${file} must write its tab to ?${param}=`,
    )
  }
})

test('the hook is the only place a tab is written, and it always replaces', () => {
  const hook = readSource('../src/navigation/useTabParam.ts')
  assert.match(hook, /\{ replace: true, state \}/)
  // A tab is not a push: nothing here may reach for a pushing navigation.
  assert.doesNotMatch(hook, /useNavigate/)
})

test("the knowledge view mode keeps its cookie as the URL's default", () => {
  const workspace = readSource('../src/components/features/knowledge/KnowledgeWorkspace.tsx')
  // The cookie seeds the fallback…
  assert.match(workspace, /const \[storedViewMode\] = useState<KnowledgeViewMode>\(\(\) => \{/)
  assert.match(workspace, /KNOWLEDGE_VIEW_MODES,\n {4}storedViewMode,/)
  // …and is rewritten on every change, so the preference still follows the reader.
  assert.match(
    workspace,
    /selectViewMode\(nextMode\)\n {4}setCookie\(VIEW_MODE_COOKIE, nextMode\)/,
  )
})
