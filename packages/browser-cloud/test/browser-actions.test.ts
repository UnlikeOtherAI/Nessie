import assert from 'node:assert/strict'
import { test } from 'node:test'

import { actInBrowser, observeBrowser, renderObservation } from '../src/browser-actions.js'
import { createBrowserbaseClient } from '../src/browserbase-client.js'
import type { CdpClient } from '../src/cdp-client.js'

type Call = { method: string; params: Record<string, unknown> }

const fakeCdp = (
  responses: Record<string, Record<string, unknown>> = {},
): { cdp: CdpClient; calls: Call[] } => {
  const calls: Call[] = []
  const cdp: CdpClient = {
    call: async (method, params = {}) => {
      calls.push({ method, params })
      return responses[method] ?? {}
    },
    pageSessionId: () => 'session-1',
    attachToPage: async () => 'session-1',
    targets: async () => [],
    close: () => {},
    closed: Promise.resolve(),
  }
  return { cdp, calls }
}

const axNode = (id: number, role: string, name: string, value?: string) => ({
  backendDOMNodeId: id,
  role: { value: role },
  name: { value: name },
  ...(value === undefined ? {} : { value: { value } }),
})

test('observe maps the accessibility tree to node ids the model can act on', async () => {
  const { cdp } = fakeCdp({
    'Accessibility.getFullAXTree': {
      nodes: [
        axNode(11, 'button', 'Sign in'),
        axNode(12, 'textbox', 'Email', 'a@b.c'),
      ],
    },
    'Page.getNavigationHistory': {
      currentIndex: 0,
      entries: [{ url: 'https://example.com/login', title: 'Login' }],
    },
  })

  const observation = await observeBrowser(cdp)

  assert.equal(observation.url, 'https://example.com/login')
  assert.equal(observation.title, 'Login')
  assert.deepEqual(observation.nodes, [
    { nodeId: 11, role: 'button', name: 'Sign in', value: '' },
    { nodeId: 12, role: 'textbox', name: 'Email', value: 'a@b.c' },
  ])
  assert.equal(observation.truncated, false)
  assert.equal(observation.screenshotBase64, undefined)
})

test('observe caps the tree so one page cannot flood the context window', async () => {
  const nodes = Array.from({ length: 250 }, (_, index) => axNode(index + 1, 'link', `L${index}`))
  const { cdp } = fakeCdp({ 'Accessibility.getFullAXTree': { nodes } })

  const observation = await observeBrowser(cdp)

  assert.equal(observation.nodes.length, 200)
  assert.equal(observation.truncated, true)
  assert.match(renderObservation(observation), /more elements omitted/)
})

test('observe drops nodes with nothing readable rather than spending tokens on them', async () => {
  const { cdp } = fakeCdp({
    'Accessibility.getFullAXTree': {
      nodes: [axNode(1, '', ''), axNode(2, 'heading', 'Welcome')],
    },
  })

  const observation = await observeBrowser(cdp)

  assert.deepEqual(observation.nodes.map((node) => node.nodeId), [2])
})

test('observe includes a screenshot only when asked', async () => {
  const { cdp, calls } = fakeCdp({
    'Accessibility.getFullAXTree': { nodes: [] },
    'Page.captureScreenshot': { data: 'AAAA' },
  })

  const withShot = await observeBrowser(cdp, { includeScreenshot: true })
  assert.equal(withShot.screenshotBase64, 'AAAA')
  assert.ok(calls.some((call) => call.method === 'Page.captureScreenshot'))
})

test('click scrolls the node into view, then presses and releases at its centre', async () => {
  const { cdp, calls } = fakeCdp({
    'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
  })

  const result = await actInBrowser(cdp, { action: 'click', nodeId: 42 })

  assert.equal(result.status, 'acted')
  assert.deepEqual(calls.map((call) => call.method), [
    'DOM.scrollIntoViewIfNeeded',
    'DOM.getBoxModel',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ])
  assert.deepEqual(calls[0]?.params, { backendNodeId: 42 })
  // Centre of the quad, matching the executor's own nodeCenter arithmetic.
  assert.equal(calls[2]?.params.x, 20)
  assert.equal(calls[2]?.params.y, 30)
  assert.equal(calls[2]?.params.type, 'mousePressed')
  assert.equal(calls[3]?.params.type, 'mouseReleased')
})

test('click refuses an element with no layout box instead of clicking nowhere', async () => {
  const { cdp } = fakeCdp({ 'DOM.getBoxModel': { model: { content: [] } } })

  await assert.rejects(
    actInBrowser(cdp, { action: 'click', nodeId: 7 }),
    /no layout box/,
  )
})

test('type focuses the node before inserting text', async () => {
  const { cdp, calls } = fakeCdp()

  await actInBrowser(cdp, { action: 'type', nodeId: 3, text: 'hello' })

  assert.deepEqual(calls.map((call) => call.method), ['DOM.focus', 'Input.insertText'])
  assert.deepEqual(calls[0]?.params, { backendNodeId: 3 })
  assert.deepEqual(calls[1]?.params, { text: 'hello' })
})

test('press sends the same key triple the executor transport sends', async () => {
  const { cdp, calls } = fakeCdp()

  await actInBrowser(cdp, { action: 'press', key: 'Enter' })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]?.params, {
    type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  })
  assert.equal(calls[1]?.params.type, 'keyUp')
})

test('navigate reports the settled URL', async () => {
  const { cdp, calls } = fakeCdp()

  const result = await actInBrowser(cdp, { action: 'navigate', url: 'https://example.com/' })

  assert.equal(result.settledUrl, 'https://example.com/')
  assert.deepEqual(calls[0], {
    method: 'Page.navigate',
    params: { url: 'https://example.com/' },
  })
})

test('scroll without a node uses the viewport centre', async () => {
  const { cdp, calls } = fakeCdp({
    'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
  })

  await actInBrowser(cdp, { action: 'scroll', deltaY: 300 })

  const wheel = calls.find((call) => call.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(wheel?.params, {
    type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 300,
  })
  assert.ok(!calls.some((call) => call.method === 'DOM.scrollIntoViewIfNeeded'))
})

/**
 * These flags are the whole reason a login handoff is safe to run inside
 * somebody's Browserbase account. If a refactor drops one, the failure is
 * silent and invisible in the product, so it is asserted here.
 */
test('every session is created with recording, logging and captcha solving OFF', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = createBrowserbaseClient(
    { apiKey: 'bb-key', projectId: 'proj-1' },
    {
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        return new Response(
          JSON.stringify({ id: 'sess-1', connectUrl: 'wss://connect.browserbase.com/x' }),
          { status: 200 },
        )
      }) as never,
    },
  )

  await client.createSession({ timeoutSeconds: 600 })

  const settings = bodies[0]?.browserSettings as Record<string, unknown>
  assert.equal(settings.recordSession, false, 'recording must be off — logins are typed here')
  assert.equal(settings.logSession, false, 'network logs would carry request data')
  assert.equal(settings.solveCaptchas, false, 'our policy is that a human solves challenges')
  assert.equal(bodies[0]?.timeout, 600, 'the platform must stop the session too')
})

test('a rejected API key is a distinct, non-retryable failure', async () => {
  const client = createBrowserbaseClient(
    { apiKey: 'bad', projectId: 'proj-1' },
    { fetchImpl: (async () => new Response('nope', { status: 401 })) as never },
  )

  await assert.rejects(
    client.createSession({ timeoutSeconds: 60 }),
    (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_AUTH_FAILED',
  )
})

test('a 429 is capacity, not an outage', async () => {
  const client = createBrowserbaseClient(
    { apiKey: 'k', projectId: 'p' },
    { fetchImpl: (async () => new Response('slow down', { status: 429 })) as never },
  )

  await assert.rejects(
    client.createSession({ timeoutSeconds: 60 }),
    (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_CAPACITY',
  )
})

test('a connect URL pointing away from Browserbase is refused', async () => {
  const client = createBrowserbaseClient(
    { apiKey: 'k', projectId: 'p' },
    {
      fetchImpl: (async () => new Response(
        JSON.stringify({ id: 'sess-1', connectUrl: 'wss://attacker.example.com/x' }),
        { status: 200 },
      )) as never,
    },
  )

  await assert.rejects(
    client.createSession({ timeoutSeconds: 60 }),
    (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_UNTRUSTED_ENDPOINT',
  )
})

/**
 * Browserbase resolves the project from the API key
 * (https://docs.browserbase.com/reference/api/create-a-session: "Optional — if
 * not provided, the project will be inferred from the API key"), so Nessie
 * stopped asking for one. The field must then be *absent* from the body: sent
 * as `null` or `"undefined"` it names a project that does not exist, and the
 * failure would look like a bad key rather than a bad body. Installs that
 * connected before this keep theirs, and their sessions and contexts stay
 * where their logins already live.
 */
test('no project id means no projectId field on the wire — never a null one', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const collect = (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
    return new Response(
      JSON.stringify({ id: 'sess-1', connectUrl: 'wss://connect.browserbase.com/x' }),
      { status: 200 },
    )
  }) as never

  for (const credentials of [
    { apiKey: 'bb-key' },
    { apiKey: 'bb-key', projectId: null },
    { apiKey: 'bb-key', projectId: '' },
  ]) {
    bodies.length = 0
    const client = createBrowserbaseClient(credentials, { fetchImpl: collect })
    await client.createSession({ timeoutSeconds: 60 })
    await client.endSession('sess-1')
    await client.createContext()
    for (const body of bodies) {
      assert.ok(
        !Object.hasOwn(body, 'projectId'),
        `projectId must be absent, got ${JSON.stringify(body.projectId)}`,
      )
    }
  }

  // A stored project id is still sent where it scopes the thing being made —
  // a session and a profile. Release takes `{status}` alone, documented and
  // asserted here so nobody puts the field back.
  bodies.length = 0
  const pinned = createBrowserbaseClient({ apiKey: 'bb-key', projectId: 'proj-1' }, { fetchImpl: collect })
  await pinned.createSession({ timeoutSeconds: 60 })
  await pinned.createContext()
  assert.equal(bodies.length, 2)
  for (const body of bodies) assert.equal(body.projectId, 'proj-1')

  bodies.length = 0
  await pinned.endSession('sess-1')
  assert.deepEqual(bodies, [{ status: 'REQUEST_RELEASE' }])
})
