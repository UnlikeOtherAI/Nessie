import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * One `/api/activity` socket per tab.
 *
 * The shell and the dashboard registry each mounted `useAgentRealtime`, and
 * because the socket was created inside the hook's own effect a signed-in tab
 * held two authenticated sockets: two handshakes, two ping timers, two backoff
 * ladders and two copies of every cache invalidation. These drive the shared
 * connection directly — a stub socket, no React and no query client — so the
 * questions the sharing turns on stay answerable.
 */

type Listener = (event: unknown) => void

const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(readonly url: string) {
    sockets.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? new Set<Listener>()
    existing.add(listener)
    this.listeners.set(type, existing)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeSocket.CLOSED
    this.emit('close', {})
  }

  /** The server accepted the upgrade. */
  accept(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open', {})
  }

  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const install = <TValue,>(key: string, value: TValue): (() => void) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  return () => {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
}

/**
 * The whole suite shares one process (`--experimental-test-isolation=none`), so
 * the two globals the connection reaches for are installed for the body of one
 * test and taken away again — a `window` left behind is another file's failure.
 *
 * `resolveWebSocketUrl` falls back to the page's own origin when no API base
 * URL is configured, which is the shape a test process has.
 */
const withSocketGlobals = async (run: () => Promise<void> | void): Promise<void> => {
  sockets.length = 0
  const restoreWindow = install('window', { location: { host: 'admin.test', protocol: 'http:' } })
  const restoreWebSocket = install('WebSocket', FakeSocket)
  try {
    await run()
  } finally {
    restoreWebSocket()
    restoreWindow()
  }
}

const { subscribeAgentActivity, unionActivityScopes } = await import(
  '../src/facades/agents/activity-socket.js'
)

const organizationId = '11111111-1111-4111-8111-111111111111'
const channelId = '22222222-2222-4222-8222-222222222222'
const otherChannelId = '33333333-3333-4333-8333-333333333333'
const dashboardId = '44444444-4444-4444-8444-444444444444'

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 80))

const scopesOf = (frame: string): unknown[] =>
  (JSON.parse(frame) as { scopes: unknown[] }).scopes

test('the union is every subscriber\'s scope, deduplicated and stably ordered', () => {
  assert.deepEqual(
    unionActivityScopes([
      { channelIds: [channelId], dashboardIds: [], organizationId },
      { channelIds: [channelId], dashboardIds: [dashboardId], organizationId },
    ]),
    [
      { kind: 'organization', organizationId },
      { channelId, kind: 'channel' },
      { dashboardId, kind: 'dashboard' },
    ],
  )
  // Stable order is what lets the connection recognise an unchanged union and
  // skip the re-subscription entirely.
  assert.deepEqual(
    unionActivityScopes([{ channelIds: [otherChannelId, channelId], dashboardIds: [], organizationId }]),
    unionActivityScopes([{ channelIds: [channelId, otherChannelId], dashboardIds: [], organizationId }]),
  )
})

test('two concurrent subscribers share one socket, and it carries both scopes', async () => {
  await withSocketGlobals(() => {
    const shellStates: string[] = []
    const dashboardStates: string[] = []
    const shellMessages: unknown[] = []
    const dashboardMessages: unknown[] = []

    const shell = subscribeAgentActivity('token-1', {
      onMessage: (message) => shellMessages.push(message),
      onState: (state) => shellStates.push(state),
      scope: { channelIds: [channelId], dashboardIds: [], organizationId },
    })
    const dashboard = subscribeAgentActivity('token-1', {
      onMessage: (message) => dashboardMessages.push(message),
      onState: (state) => dashboardStates.push(state),
      scope: { channelIds: [], dashboardIds: [dashboardId], organizationId },
    })

    assert.equal(sockets.length, 1, 'the second subscriber must not open a socket of its own')
    const socket = sockets[0]!
    assert.match(socket.url, /\/api\/activity\?token=token-1$/)

    socket.accept()
    assert.equal(socket.sent.length, 1)
    assert.deepEqual(scopesOf(socket.sent[0]!), [
      { kind: 'organization', organizationId },
      { channelId, kind: 'channel' },
      { dashboardId, kind: 'dashboard' },
    ])

    socket.deliver({ scopes: [], snapshot: { agents: [] }, type: 'subscribed' })
    assert.equal(shellStates.at(-1), 'connected')
    assert.equal(dashboardStates.at(-1), 'connected')
    assert.equal(shellMessages.length, 1)
    assert.equal(dashboardMessages.length, 1)

    shell.unsubscribe()
    dashboard.unsubscribe()
    assert.equal(socket.closed, true, 'the last subscriber to leave closes the connection')
    assert.equal(sockets.length, 1)
  })
})

test('a scope change re-sends the union once, and an unchanged one sends nothing', async () => {
  await withSocketGlobals(async () => {
    const shell = subscribeAgentActivity('token-2', {
      onMessage: () => undefined,
      onState: () => undefined,
      scope: { channelIds: [channelId], dashboardIds: [], organizationId },
    })
    const dashboard = subscribeAgentActivity('token-2', {
      onMessage: () => undefined,
      onState: () => undefined,
      scope: { channelIds: [], dashboardIds: [dashboardId], organizationId },
    })
    const socket = sockets[0]!
    socket.accept()
    assert.equal(socket.sent.length, 1)

    // Two scope moves inside one route change coalesce into a single frame.
    shell.setScope({ channelIds: [otherChannelId], dashboardIds: [], organizationId })
    dashboard.setScope({ channelIds: [], dashboardIds: [dashboardId], organizationId })
    await settled()
    assert.equal(socket.sent.length, 2)
    assert.deepEqual(scopesOf(socket.sent[1]!), [
      { kind: 'organization', organizationId },
      { channelId: otherChannelId, kind: 'channel' },
      { dashboardId, kind: 'dashboard' },
    ])

    // Re-declaring the same scope is not a re-subscription.
    shell.setScope({ channelIds: [otherChannelId], dashboardIds: [], organizationId })
    await settled()
    assert.equal(socket.sent.length, 2)

    // One subscriber leaving narrows the union without dropping the connection.
    dashboard.unsubscribe()
    await settled()
    assert.equal(socket.closed, false)
    assert.equal(socket.sent.length, 3)
    assert.deepEqual(scopesOf(socket.sent[2]!), [
      { kind: 'organization', organizationId },
      { channelId: otherChannelId, kind: 'channel' },
    ])

    shell.unsubscribe()
    assert.equal(socket.closed, true)
  })
})

test('a rotated token reopens the connection', async () => {
  await withSocketGlobals(() => {
    const first = subscribeAgentActivity('token-3', {
      onMessage: () => undefined,
      onState: () => undefined,
      scope: { channelIds: [], dashboardIds: [], organizationId },
    })
    sockets[0]!.accept()

    const second = subscribeAgentActivity('token-4', {
      onMessage: () => undefined,
      onState: () => undefined,
      scope: { channelIds: [], dashboardIds: [], organizationId },
    })
    assert.equal(sockets.length, 2)
    assert.equal(sockets[0]!.closed, true)
    assert.match(sockets[1]!.url, /token=token-4$/)

    first.unsubscribe()
    second.unsubscribe()
    assert.equal(sockets[1]!.closed, true)
  })
})
