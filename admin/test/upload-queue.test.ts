import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

/**
 * The upload queue (uploads-and-indexing.md §2).
 *
 * The pure half — ordering, the concurrency window, the quota cascade, retry —
 * is asserted directly. The live half is driven through the hook against a
 * fake driver, because "two at a time" and "cancel aborts the request" are
 * claims about what the runner does over time, and a pure function cannot be
 * wrong about them.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/knowledge-base',
})

const React = await import('react')
const { act, createElement: h, useEffect } = React
const { createRoot } = await import('react-dom/client')

// Deliberately narrow: this suite runs with `--experimental-test-isolation=none`,
// so a file that plants its own `window` on `globalThis` changes the world for
// every file imported after it — `tenant-host-branding` plants a fake one and
// reads its `location` back at test time. React only needs `window` to *exist*
// (it reads `window.event` for update priority) and takes the document off the
// container element it is handed, so this claims the global only when nobody
// else has, and never takes it away from whoever did.
const globals = globalThis as typeof globalThis & Record<string, unknown>
globals.React = React
globals.IS_REACT_ACT_ENVIRONMENT = true
if (typeof globals.window === 'undefined') globals.window = dom.window

const {
  cascadeQuota,
  failureLine,
  folderPathsFor,
  MAX_IN_FLIGHT,
  nextStartable,
  placeholdersIn,
  queueHeadline,
  queueSummaryLine,
  retryFrom,
  useUploadQueue,
} = await import('../src/components/features/knowledge/finder/useUploadQueue.js')
const { UploadAbortedError } = await import('../src/lib/upload-xhr.js')

type Entry = Parameters<typeof cascadeQuota>[0][number]

const SPACE = '00000000-0000-4000-8000-000000000001'

const file = (name: string, bytes = 8): File =>
  new dom.window.File([new Uint8Array(bytes)], name, { type: 'text/plain' })

const entry = (overrides: Partial<Entry> & { id: string; title: string }): Entry => ({
  dropParentPageId: null,
  file: file(overrides.title),
  relativePath: [],
  state: { kind: 'queued' },
  targetParentPageId: null,
  targetSpaceId: SPACE,
  ...overrides,
})

// ── Pure ────────────────────────────────────────────────────────────────────

test('never more than two go up at once, and they go in drop order', () => {
  assert.equal(MAX_IN_FLIGHT, 2)
  const queued = [
    entry({ id: 'a', title: 'a.txt' }),
    entry({ id: 'b', title: 'b.pdf' }),
    entry({ id: 'c', title: 'c.png' }),
  ]

  assert.deepEqual(nextStartable(queued).map((row) => row.id), ['a', 'b'])

  // One already in flight leaves room for exactly one more.
  const oneUp = [
    { ...queued[0], state: { kind: 'uploading', pct: 12 } } as Entry,
    queued[1],
    queued[2],
  ]
  assert.deepEqual(nextStartable(oneUp).map((row) => row.id), ['b'])

  const twoUp = [
    { ...queued[0], state: { kind: 'uploading', pct: 12 } } as Entry,
    { ...queued[1], state: { kind: 'uploading', pct: 3 } } as Entry,
    queued[2],
  ]
  assert.deepEqual(nextStartable(twoUp), [])
})

test('a dropped folder tree is created shallowest first, each path once', () => {
  const dropped = [
    entry({ id: '1', relativePath: ['Contracts', '2026'], title: 'lease.pdf' }),
    entry({ id: '2', relativePath: ['Contracts'], title: 'notes.txt' }),
    entry({ id: '3', relativePath: ['Contracts', '2026'], title: 'rider.pdf' }),
    entry({ id: '4', relativePath: [], title: 'top.txt' }),
  ]

  assert.deepEqual(folderPathsFor(dropped), [
    ['Contracts'],
    ['Contracts', '2026'],
  ])
})

test('one quota refusal settles every file still queued', () => {
  const before = [
    { ...entry({ id: 'a', title: 'a.txt' }), state: { kind: 'uploading', pct: 90 } } as Entry,
    entry({ id: 'b', title: 'b.pdf' }),
    entry({ id: 'c', title: 'c.png' }),
    { ...entry({ id: 'd', title: 'd.txt' }), state: { kind: 'done', pageId: 'p' } } as Entry,
  ]

  const after = cascadeQuota(before, 'a', 'Storage quota exceeded')

  assert.deepEqual(after.map((row) => row.state.kind), ['failed', 'skipped', 'skipped', 'done'])
  // The one that hit the wall says what happened; the rest say they never
  // started, which is a different and truer sentence.
  assert.equal(failureLine(after[0].state), 'Not uploaded — storage is full')
  assert.equal(failureLine(after[1].state), 'Skipped — storage is full')
  // A file that already landed is not un-landed by somebody else's refusal.
  assert.equal(after[3].state.kind, 'done')
})

test('retry on a quota casualty re-queues the whole group; anything else, one', () => {
  const settled = cascadeQuota([
    { ...entry({ id: 'a', title: 'a.txt' }), state: { kind: 'uploading' } } as Entry,
    entry({ id: 'b', title: 'b.pdf' }),
    entry({ id: 'c', title: 'c.png' }),
  ], 'a', 'full')

  // "Retry" on the *skipped* one takes the failed one with it: one file at a
  // time into a bucket that is still full is the same refusal again.
  const all = retryFrom(settled, 'b')
  assert.deepEqual(all.map((row) => row.state.kind), ['queued', 'queued', 'queued'])

  const oneOff = retryFrom([
    { ...entry({ id: 'x', title: 'x.txt' }), state: { code: 'NETWORK', kind: 'failed', message: 'Upload failed' } } as Entry,
    { ...entry({ id: 'y', title: 'y.txt' }), state: { code: 'FILE_TOO_LARGE', kind: 'failed', message: 'too big' } } as Entry,
  ], 'x')
  assert.deepEqual(oneOff.map((row) => row.state.kind), ['queued', 'failed'])
})

test('the tray says what is happening, then what happened', () => {
  const running = [
    { ...entry({ id: 'a', title: 'a.txt' }), state: { kind: 'done', pageId: 'p' } } as Entry,
    { ...entry({ id: 'b', title: 'b.pdf' }), state: { kind: 'uploading', pct: 40 } } as Entry,
    entry({ id: 'c', title: 'c.png' }),
  ]
  assert.equal(queueHeadline(running), 'Uploading 2 of 3 · b.pdf 40%')

  const clean = running.map((row) => ({ ...row, state: { kind: 'done', pageId: 'p' } }) as Entry)
  assert.equal(queueSummaryLine(clean), '3 files uploaded')

  const mixed = [
    ...clean.slice(0, 2),
    { ...running[2], state: { code: 'NETWORK', kind: 'failed', message: 'Upload failed' } } as Entry,
  ]
  assert.equal(queueSummaryLine(mixed), '2 of 3 uploaded — 1 failed')
})

test('a placeholder row appears in the folder the file is going into, and stops at done', () => {
  const rows = [
    entry({ id: 'a', dropParentPageId: 'folder-1', targetParentPageId: 'folder-1', title: 'a.txt' }),
    { ...entry({ id: 'b', dropParentPageId: 'folder-1', targetParentPageId: 'folder-1', title: 'b.pdf' }), state: { kind: 'uploading', pct: 12 } } as Entry,
    { ...entry({ id: 'c', dropParentPageId: 'folder-1', targetParentPageId: 'folder-1', title: 'c.png' }), state: { kind: 'done', pageId: 'page-c' } } as Entry,
    entry({ id: 'd', title: 'd.txt' }),
  ]

  const inFolder = placeholdersIn(rows, 'folder-1')
  assert.deepEqual(inFolder.map((row) => row.id), ['a', 'b'])
  assert.equal(inFolder[0].upload.label, 'Waiting')
  assert.equal(inFolder[1].upload.label, 'Uploading… 12%')
  assert.equal(inFolder[1].upload.pct, 12)

  // A file whose folders do not exist yet has no column to stand in.
  assert.deepEqual(placeholdersIn([
    entry({ id: 'n', relativePath: ['New'], targetParentPageId: undefined, title: 'n.txt' }),
  ], null), [])

  assert.deepEqual(placeholdersIn(rows, null).map((row) => row.id), ['d'])
})

// ── The runner ──────────────────────────────────────────────────────────────

type Started = {
  abort: () => void
  aborted: boolean
  parentPageId: string | null
  reject: (error: unknown) => void
  resolve: (page: { id: string; spaceId: string }) => void
  status: number
  title: string
}

const fakeDriver = () => {
  const started: Started[] = []
  const folders: string[] = []
  const deleted: string[] = []
  return {
    deleted,
    driver: {
      createFolder: async ({ title }: { title: string }) => {
        folders.push(title)
        return { id: `folder-${title}`, spaceId: SPACE } as never
      },
      deletePage: async (pageId: string) => {
        deleted.push(pageId)
      },
      invalidateSpace: () => undefined,
      startUpload: ({ parentPageId, title }: { parentPageId: string | null; title?: string }) => {
        const xhr = { status: 0 } as XMLHttpRequest
        let settle!: Started
        const result = new Promise<never>((resolve, reject) => {
          settle = {
            abort: () => {
              settle.aborted = true
              reject(new UploadAbortedError())
            },
            aborted: false,
            parentPageId,
            reject: (error: unknown) => {
              ;(xhr as { status: number }).status = settle.status
              reject(error)
            },
            resolve: resolve as never,
            status: 0,
            title: title ?? '',
          }
        })
        started.push(settle)
        return { abort: () => settle.abort(), result, xhr }
      },
    },
    folders,
    started,
  }
}

const mountQueue = async (driver: unknown) => {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.append(host)
  const root = createRoot(host)
  let api!: ReturnType<typeof useUploadQueue>
  const Probe = ({ onApi }: { onApi: (value: typeof api) => void }) => {
    const queue = useUploadQueue({ driver: driver as never, onNotice: () => undefined })
    useEffect(() => onApi(queue))
    return null
  }
  await act(async () => {
    root.render(h(Probe, { onApi: (value: typeof api) => { api = value } }))
  })
  return {
    get api() {
      return api
    },
    unmount: () => act(async () => root.unmount()),
  }
}

const drop = (names: string[], relativePath: string[] = []) => ({
  directoriesUnsupported: false,
  entries: names.map((name) => ({ file: file(name), relativePath })),
  refusal: null,
})

test('three dropped files start two uploads, and the third waits for a slot', async () => {
  const fake = fakeDriver()
  const mounted = await mountQueue(fake.driver)

  await act(async () => {
    mounted.api.enqueue(drop(['a.txt', 'b.pdf', 'c.png']) as never, {
      parentPageId: 'folder-1',
      spaceId: SPACE,
    })
  })

  assert.deepEqual(fake.started.map((row) => row.title), ['a.txt', 'b.pdf'])
  assert.deepEqual(
    mounted.api.entries.map((row) => row.state.kind),
    ['uploading', 'uploading', 'queued'],
  )

  await act(async () => {
    fake.started[0].resolve({ id: 'page-a', spaceId: SPACE })
  })

  assert.deepEqual(fake.started.map((row) => row.title), ['a.txt', 'b.pdf', 'c.png'])
  assert.deepEqual(
    mounted.api.entries.map((row) => row.state.kind),
    ['done', 'uploading', 'uploading'],
  )
  await mounted.unmount()
})

test('cancel aborts the live request and says so', async () => {
  const fake = fakeDriver()
  const mounted = await mountQueue(fake.driver)

  await act(async () => {
    mounted.api.enqueue(drop(['a.txt', 'b.pdf', 'c.png']) as never, {
      parentPageId: null,
      spaceId: SPACE,
    })
  })

  const [first] = mounted.api.entries
  await act(async () => mounted.api.cancel(first.id))

  assert.equal(fake.started[0].aborted, true)
  assert.equal(mounted.api.entries[0].state.kind, 'failed')
  assert.equal(failureLine(mounted.api.entries[0].state), 'Cancelled')

  // A queued entry has no request to abort; it simply never starts.
  await act(async () => mounted.api.cancelAll())
  assert.equal(
    mounted.api.entries.some((row) => row.state.kind === 'queued'),
    false,
  )
  await mounted.unmount()
})

test('a 507 on one file skips every file still queued', async () => {
  const fake = fakeDriver()
  const mounted = await mountQueue(fake.driver)

  await act(async () => {
    mounted.api.enqueue(drop(['a.txt', 'b.pdf', 'c.png', 'd.txt']) as never, {
      parentPageId: null,
      spaceId: SPACE,
    })
  })

  await act(async () => {
    fake.started[0].status = 507
    fake.started[0].reject(new Error('Storage quota exceeded'))
  })

  assert.equal(mounted.api.entries[0].state.kind, 'failed')
  assert.equal(failureLine(mounted.api.entries[0].state), 'Not uploaded — storage is full')
  assert.deepEqual(
    mounted.api.entries.slice(2).map((row) => row.state.kind),
    ['skipped', 'skipped'],
  )
  await mounted.unmount()
})

test('a dropped folder is created once, before the files inside it', async () => {
  const fake = fakeDriver()
  const mounted = await mountQueue(fake.driver)

  await act(async () => {
    mounted.api.enqueue(drop(['lease.pdf', 'rider.pdf'], ['Contracts']) as never, {
      parentPageId: null,
      spaceId: SPACE,
    })
  })
  // The folder promise is shared, so two files in one folder are one POST.
  await act(async () => undefined)

  assert.deepEqual(fake.folders, ['Contracts'])
  assert.deepEqual(fake.started.map((row) => row.parentPageId), [
    'folder-Contracts',
    'folder-Contracts',
  ])
  await mounted.unmount()
})

test('leaving the Finder aborts whatever is still going up', async () => {
  const fake = fakeDriver()
  const mounted = await mountQueue(fake.driver)

  await act(async () => {
    mounted.api.enqueue(drop(['a.txt', 'b.pdf']) as never, {
      parentPageId: null,
      spaceId: SPACE,
    })
  })
  await mounted.unmount()

  assert.deepEqual(fake.started.map((row) => row.aborted), [true, true])
})
