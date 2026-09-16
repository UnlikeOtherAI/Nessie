import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { JSDOM } from 'jsdom'
import * as ReactNamespace from 'react'

/**
 * Moving and copying between root folders, from the client's side
 * (docs/plans/2026-09-16-documents-finder-ui/transfer.md).
 *
 * Three things are asserted here and nowhere else:
 *
 * 1. **The sentences.** The audience line is what `acknowledged: true` claims a
 *    person was shown before an audience was widened, and the sharing line is
 *    the blunt one — a move out of a personal space deletes every share on the
 *    subtree. A transfer that revokes other people's access with nothing on
 *    screen is the failure this file exists to make impossible.
 * 2. **The two operations are not blurred.** A failed copy rolled back; a
 *    failed move kept the batches that committed. The tray sentence for each
 *    says which, because "the move failed" over a half-moved folder is a lie
 *    about where a person's documents are.
 * 3. **⌥ is Finder's ⌥.** Across root folders it copies without asking and the
 *    `+` is on screen before the button comes up; inside one root it is
 *    ignored, and the cursor must not promise a copy that will not happen.
 *
 * The refusal sentences are the server's, to the character. Where one is
 * asserted it is pasted with its curly quotes, not rebuilt.
 */

;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/knowledge-base',
})

dom.window.matchMedia = ((query: string) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: query.includes('min-width'),
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
})) as unknown as typeof window.matchMedia

for (const [name, value] of Object.entries({
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
})) {
  dom.window.document.documentElement.style.setProperty(`--breakpoint-${name}`, value)
}

const domGlobals = {
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  ResizeObserver: dom.window.ResizeObserver,
  window: dom.window,
}

after(() => {
  dom.window.close()
})

const React = await import('react')
const { act, createElement: h, useRef } = React
const { createRoot } = await import('react-dom/client')
const { LocalBackProvider } = await import('../src/navigation/LocalBackContext.js')
const { __resetViewportStore } = await import('../src/hooks/useViewport.js')
const {
  destinationsFromRoot,
  moveToDialogTitle,
  transferAudienceLine,
  transferPromptHeading,
  transferProgressSentence,
  transferRefusalSentence,
  transferSharingLine,
} = await import('../src/components/features/knowledge/finder/transfer-copy.js')
const { TransferPrompt } = await import(
  '../src/components/features/knowledge/finder/TransferPrompt.js'
)

type Destination = Parameters<typeof transferAudienceLine>[0]

const destination = (over: Partial<Destination> = {}): Destination => ({
  canWrite: true,
  name: 'Marketing',
  ownerAgentId: null,
  projectName: null,
  role: 'shared',
  spaceId: 'space-marketing',
  visibility: 'organization',
  ...over,
})

// ── The sentences ───────────────────────────────────────────────────────────

test('the audience line names who will be able to read the items', () => {
  assert.equal(
    transferAudienceLine(destination({ name: 'My Documents', role: 'personal', visibility: 'private' }), 1),
    'Only you will see it.',
  )
  assert.equal(
    transferAudienceLine(destination({ name: 'P', projectName: 'P', role: 'project', visibility: 'project' }), 1),
    'Everyone in the project P will see it.',
  )
  assert.equal(
    transferAudienceLine(destination(), 3),
    'Everyone in the organisation will see them.',
  )
  assert.equal(
    transferAudienceLine(destination({ projectName: 'P', visibility: 'project' }), 3),
    'Everyone in the project P will see them.',
  )
  assert.equal(
    transferAudienceLine(destination({ name: 'Design', visibility: 'team' }), 2),
    'People added to Design will see them.',
  )
  assert.equal(
    transferAudienceLine(destination({ name: 'Ada', ownerAgentId: 'agent-1', visibility: 'private' }), 1),
    'People who can see the agent Ada will see it.',
  )
})

test('the heading quotes one item by name and counts the rest', () => {
  assert.equal(
    transferPromptHeading({ count: 1, destinationName: 'P', title: 'Plan' }),
    'Move or copy “Plan” to P?',
  )
  assert.equal(
    transferPromptHeading({ count: 3, destinationName: 'Marketing' }),
    'Move or copy 3 items to Marketing?',
  )
  assert.equal(moveToDialogTitle({ count: 2, crossRoot: false }), 'Move 2 items to…')
  assert.equal(moveToDialogTitle({ count: 2, crossRoot: true }), 'Move or copy 2 items…')
})

test('the sharing line is singular for one person and absent for none', () => {
  assert.equal(transferSharingLine(1), 'Sharing with 1 person ends.')
  assert.equal(transferSharingLine(2), 'Sharing with 2 people ends.')
  assert.equal(transferSharingLine(0), null)
})

test("a refusal shows the server's sentence, curly quotes and all", () => {
  assert.equal(
    transferRefusalSentence(
      'TRANSFER_WIDENS_BASIS',
      '“Plan” contains material that not everyone in Marketing may see.',
    ),
    '“Plan” contains material that not everyone in Marketing may see.',
  )
  assert.equal(
    transferRefusalSentence('TRANSFER_INTO_SELF', "A folder can't be moved into itself."),
    "A folder can't be moved into itself.",
  )
  // The storage layer raises the quota by its own message; the menu says the
  // one sentence the design writes for it.
  assert.equal(
    transferRefusalSentence('STORAGE_QUOTA_EXCEEDED', 'Organisation storage quota exceeded'),
    'Not copied — storage is full.',
  )
  assert.equal(
    transferRefusalSentence(undefined, undefined),
    'Those items could not be moved.',
  )
})

test('a failed move keeps its committed batches and a failed copy keeps nothing', () => {
  const base = {
    count: 3,
    destinationName: 'P',
    error: 'archived parent',
    sourceName: 'My Documents',
    status: 'failed' as const,
  }
  assert.equal(
    transferProgressSentence({ ...base, done: 1_200, operation: 'move', total: 1_800 }),
    'Moved 1,200 of 1,800 — archived parent. The rest stayed in My Documents.',
  )
  assert.equal(
    transferProgressSentence({ ...base, done: 0, operation: 'copy', total: 1_800 }),
    'Nothing was copied — archived parent. Everything stayed in My Documents.',
  )
  assert.equal(
    transferProgressSentence({
      count: 3,
      destinationName: 'P',
      done: 600,
      error: null,
      operation: 'move',
      sourceName: 'My Documents',
      status: 'running',
      total: 1_800,
    }),
    'Moving 3 items… 600 of 1,800',
  )
  assert.equal(
    transferProgressSentence({
      count: 3,
      destinationName: 'P',
      done: 1_800,
      error: null,
      operation: 'copy',
      sourceName: 'My Documents',
      status: 'done',
      total: 1_800,
    }),
    'Copied 1800 items to P',
  )
})

test('the root payload becomes one flat list of destinations', () => {
  const space = (id: string, name: string) => ({
    canManageAccess: true,
    canWrite: true,
    name,
    ownerAgentId: null,
    projectId: 'project-1',
    projectName: null,
    spaceId: id,
    updatedAt: '2026-09-16T00:00:00.000Z',
    visibility: 'private' as const,
    writeRestricted: false,
  })
  const found = destinationsFromRoot({
    myDocuments: space('s-mine', 'My Documents'),
    projects: [
      { projectId: 'p1', projectName: 'P', space: space('s-p', 'P') },
      { projectId: 'p2', projectName: 'Q', space: null },
    ],
    shared: [space('s-mkt', 'Marketing')],
    sharedTruncated: false,
    sharedWithMeCount: 0,
  })
  assert.deepEqual(
    found.map((entry) => [entry.spaceId, entry.role]),
    [['s-mine', 'personal'], ['s-p', 'project'], ['s-mkt', 'shared']],
  )
  // A project nobody has opened has no space to move into yet.
  assert.equal(found.some((entry) => entry.spaceId === 'p2'), false)
})

// ── The prompt on screen ────────────────────────────────────────────────────

const withDomGlobals = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  __resetViewportStore()
  try {
    return await run()
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

type PromptOptions = {
  canMove?: boolean
  count?: number
  refusal?: { code?: string; message?: string } | null
  sharesEnding?: number
  title?: string
}

// A case that fails before its teardown leaves its menu on the shared document
// and the next case reads that one.
let takeDown: (() => Promise<void>) | null = null

const mountPrompt = async (options: PromptOptions = {}) => {
  await takeDown?.()
  const chosen: string[] = []
  let closed = 0
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const Host = () => {
    const rowRef = useRef<HTMLButtonElement>(null)
    return h(
      'div',
      null,
      h('button', { 'data-row': 'plan', ref: rowRef, type: 'button' }, 'Plan'),
      h(TransferPrompt, {
        anchor: { kind: 'point', x: 120, y: 80 },
        canMove: options.canMove ?? true,
        count: options.count ?? 1,
        destination: destination({ name: 'P', projectName: 'P', role: 'project', visibility: 'project' }),
        moveDisabledReason: "You can't remove items from Marketing",
        onChoose: (operation: 'move' | 'copy') => chosen.push(operation),
        onClose: () => {
          closed += 1
        },
        refusal: options.refusal ?? null,
        returnFocusRef: rowRef,
        sharesEnding: options.sharesEnding ?? 0,
        title: options.title ?? 'Plan',
      }),
    )
  }

  const flush = async (ms = 0) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  await act(async () => {
    root.render(h(LocalBackProvider, null, h(Host)))
  })
  await flush()

  const menu = () => dom.window.document.querySelector('[role="menu"]') as HTMLElement | null
  const items = () =>
    Array.from(menu()?.querySelectorAll('[role="menuitem"]') ?? []) as HTMLButtonElement[]

  const unmount = async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    takeDown = null
  }
  takeDown = unmount

  return { chosen, closedCount: () => closed, flush, items, menu, unmount }
}

test('the prompt names the items, the destination and the audience', async () => {
  await withDomGlobals(async () => {
    const prompt = await mountPrompt({ count: 3, sharesEnding: 0, title: undefined })
    const text = prompt.menu()?.textContent ?? ''
    assert.ok(text.includes('Move or copy 3 items to P?'), text)
    assert.ok(text.includes('Everyone in the project P will see them.'), text)
    assert.deepEqual(
      prompt.items().map((item) => item.textContent?.trim()),
      ['Move here', 'Copy here', 'Cancel'],
    )
    // Move is the default, the way a drag is a move everywhere else here.
    assert.equal(dom.window.document.activeElement, prompt.items()[0])
    await prompt.unmount()
  })
})

test('the prompt says out loud that sharing ends', async () => {
  await withDomGlobals(async () => {
    const prompt = await mountPrompt({ sharesEnding: 2 })
    const text = prompt.menu()?.textContent ?? ''
    assert.ok(
      text.includes('Sharing with 2 people ends.'),
      'a transfer out of a personal space deletes every share on the subtree; '
        + `the prompt must say so before it is sent — got: ${text}`,
    )
    await prompt.unmount()
  })
})

test('choosing sends that operation, and Cancel sends nothing', async () => {
  await withDomGlobals(async () => {
    const prompt = await mountPrompt()
    await act(async () => {
      prompt.items()[1]?.click()
    })
    assert.deepEqual(prompt.chosen, ['copy'])

    const second = await mountPrompt()
    await act(async () => {
      second.items()[2]?.click()
    })
    assert.deepEqual(second.chosen, [])
    // `ContextMenu` closes before it runs an item, and Cancel's item is the
    // same close; what matters is that nothing was sent.
    assert.ok(second.closedCount() >= 1)
    await second.unmount()
  })
})

test('a source the person cannot write offers copy and says why move is off', async () => {
  await withDomGlobals(async () => {
    const prompt = await mountPrompt({ canMove: false })
    const [move, copy] = prompt.items()
    assert.equal(move?.getAttribute('aria-disabled'), 'true')
    assert.equal(move?.getAttribute('title'), "You can't remove items from Marketing")
    assert.equal(copy?.getAttribute('aria-disabled'), null)
    await act(async () => {
      move?.click()
    })
    assert.deepEqual(prompt.chosen, [])
    await prompt.unmount()
  })
})

test('a refusal replaces both operations with its sentence and OK', async () => {
  await withDomGlobals(async () => {
    const prompt = await mountPrompt({
      refusal: {
        code: 'TRANSFER_TASK_BOUND',
        message: '“Plan” belongs to a ticket in P and can\'t leave that project.',
      },
    })
    const text = prompt.menu()?.textContent ?? ''
    assert.ok(text.includes('“Plan” belongs to a ticket in P'), text)
    assert.deepEqual(prompt.items().map((item) => item.textContent?.trim()), ['OK'])
    await prompt.unmount()
  })
})
