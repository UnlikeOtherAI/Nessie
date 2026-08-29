import assert from 'node:assert/strict'
import test from 'node:test'

import {
  connectErrorPresentation,
  normalizeConnectError,
} from '../src/components/features/apps/connect-error-copy.js'
import {
  CONNECT_AUTHORIZATION_TIMEOUT_MS,
  CONNECT_STILL_WAITING_MS,
  connectMarkerKey,
  connectReducer,
  connectShowsSlowProviderNote,
  connectSteps,
  initialConnectState,
  parseAppConnectResponse,
  parseConnectCompletionMessage,
  parseConnectMarker,
  resolveApiOrigin,
  serializeConnectMarker,
  type ConnectEvent,
  type ConnectState,
} from '../src/components/features/apps/connect-flow.js'
import {
  authPopupFeatures,
  createWindowAuthLauncher,
  type ExternalAuthWindow,
} from '../src/components/features/apps/external-auth-launcher.js'

/**
 * The connect flow's hard cases are all timing cases — a window closed before
 * the exchange landed, a message that never arrives, a provider taking two
 * minutes — so they live in a pure reducer and are driven here as event
 * sequences rather than watched through an effect.
 */

const run = (events: ConnectEvent[], from: ConnectState = initialConnectState): ConnectState =>
  events.reduce(connectReducer, from)

const authorize = (): ConnectEvent => ({
  result: {
    authorizationUrl: 'https://github.com/login/oauth/authorize?x=1',
    connectionId: 'conn-1',
    status: 'authorize',
  },
  type: 'server_result',
})

// ─── The server's answer is checked, not assumed ────────────────────────────

test('a connect response is only believed in the three shapes the server states', () => {
  assert.deepEqual(
    parseAppConnectResponse({ connectionId: 'conn-1', status: 'connected' }),
    { connectionId: 'conn-1', status: 'connected' },
  )
  assert.deepEqual(
    parseAppConnectResponse({ connectionId: 'conn-1', status: 'needs_secret' }),
    { connectionId: 'conn-1', status: 'needs_secret' },
  )
  assert.equal(parseAppConnectResponse({ connectionId: 'conn-1', status: 'ready' }), null)
  assert.equal(parseAppConnectResponse({ status: 'connected' }), null)
  assert.equal(parseAppConnectResponse(null), null)
  assert.equal(parseAppConnectResponse('connected'), null)
})

test('an authorization URL that is not http(s) is refused rather than opened', () => {
  assert.equal(
    parseAppConnectResponse({
      authorizationUrl: 'javascript:alert(1)',
      connectionId: 'conn-1',
      status: 'authorize',
    }),
    null,
  )
  assert.equal(
    parseAppConnectResponse({ connectionId: 'conn-1', status: 'authorize' }),
    null,
  )
  assert.deepEqual(
    parseAppConnectResponse({
      authorizationUrl: 'https://idp.example/authorize',
      connectionId: 'conn-1',
      status: 'authorize',
    }),
    {
      authorizationUrl: 'https://idp.example/authorize',
      connectionId: 'conn-1',
      status: 'authorize',
    },
  )
})

// ─── The completion message ─────────────────────────────────────────────────

test('only the callback page’s fixed payload counts as a completion', () => {
  assert.deepEqual(
    parseConnectCompletionMessage({ kind: 'mcp-oauth', ok: true, source: 'nessie' }),
    { ok: true },
  )
  assert.deepEqual(
    parseConnectCompletionMessage({ kind: 'mcp-oauth', ok: false, source: 'nessie' }),
    { ok: false },
  )
  assert.equal(
    parseConnectCompletionMessage({ kind: 'mcp-oauth', ok: 'yes', source: 'nessie' }),
    null,
  )
  assert.equal(parseConnectCompletionMessage({ kind: 'other', ok: true, source: 'nessie' }), null)
  assert.equal(parseConnectCompletionMessage({ kind: 'mcp-oauth', ok: true }), null)
  assert.equal(parseConnectCompletionMessage('ok'), null)
})

test('the origin a completion may come from is the API’s, never a wildcard', () => {
  assert.equal(resolveApiOrigin('', 'https://app.nessie.works'), 'https://app.nessie.works')
  assert.equal(
    resolveApiOrigin('https://api.nessie.works', 'https://app.nessie.works'),
    'https://api.nessie.works',
  )
  assert.equal(
    resolveApiOrigin('https://api.nessie.works/', 'https://app.nessie.works'),
    'https://api.nessie.works',
  )
  // A base URL we cannot parse falls back to the page's own origin — never to
  // accepting every origin.
  assert.equal(resolveApiOrigin(':::', 'https://app.nessie.works'), 'https://app.nessie.works')
})

// ─── Classifying what threw ─────────────────────────────────────────────────

test('an error carrying a known code keeps it; prose does not become a diagnosis', () => {
  assert.deepEqual(
    normalizeConnectError(Object.assign(new Error('nope'), { code: 'SERVER_UNREACHABLE' })),
    { code: 'SERVER_UNREACHABLE', detail: 'nope' },
  )
  assert.deepEqual(
    normalizeConnectError(new Error('OAUTH_DISCOVERY_FAILED')),
    { code: 'OAUTH_DISCOVERY_FAILED', detail: null },
  )
  assert.deepEqual(
    normalizeConnectError(new Error('connect ECONNREFUSED 10.0.0.1:443')),
    { code: 'CONNECTION_FAILED', detail: 'connect ECONNREFUSED 10.0.0.1:443' },
  )
  assert.deepEqual(normalizeConnectError('boom'), { code: 'CONNECTION_FAILED', detail: null })
})

// ─── The flow ───────────────────────────────────────────────────────────────

test('a server needing no sign-in goes straight to connected', () => {
  const state = run([
    { type: 'start' },
    { result: { connectionId: 'conn-1', status: 'connected' }, type: 'server_result' },
  ])
  assert.equal(state.phase, 'connected')
  assert.equal(state.requiresAuthorization, false)
  assert.equal(state.connectionId, 'conn-1')
})

test('a key-based server hands off to the credential path instead of failing', () => {
  const state = run([
    { type: 'start' },
    { result: { connectionId: 'conn-1', status: 'needs_secret' }, type: 'server_result' },
  ])
  assert.equal(state.phase, 'needs_secret')
})

test('a reported sign-in is confirmed by the account, not taken on the message', () => {
  const reported = run([
    { type: 'start' },
    authorize(),
    { opened: true, type: 'launcher_result' },
    { ok: true, type: 'authorization_reported' },
  ])
  assert.equal(reported.phase, 'verifying')
  assert.equal(reported.verifyReason, 'reported')

  const connected = connectReducer(reported, { connected: true, type: 'connection_observed' })
  assert.equal(connected.phase, 'connected')
})

test('a closed window is verified before it is called a cancellation', () => {
  const closed = run([
    { type: 'start' },
    authorize(),
    { opened: true, type: 'launcher_result' },
    { type: 'authorization_closed' },
  ])
  assert.equal(closed.phase, 'verifying')

  // The exchange had landed a moment before the person closed the window.
  const rescued = connectReducer(closed, { connected: true, type: 'connection_observed' })
  assert.equal(rescued.phase, 'connected')
  assert.equal(rescued.error, null)
})

test('why we were verifying decides the sentence when nothing ever arrives', () => {
  const afterClose = run([
    { type: 'start' },
    authorize(),
    { type: 'authorization_closed' },
    { type: 'verification_exhausted' },
  ])
  assert.equal(afterClose.error?.code, 'AUTH_CANCELLED')

  const afterReport = run([
    { type: 'start' },
    authorize(),
    { ok: true, type: 'authorization_reported' },
    { type: 'verification_exhausted' },
  ])
  assert.equal(afterReport.error?.code, 'CONNECTION_FAILED')
})

test('a callback reporting failure is the provider refusing, not a cancellation', () => {
  const state = run([{ type: 'start' }, authorize(), { ok: false, type: 'authorization_reported' }])
  assert.equal(state.phase, 'error')
  assert.equal(state.error?.code, 'AUTH_FAILED')
})

test('the wait admits slowness at 20s and stops claiming to wait at 120s', () => {
  const waiting = run([{ type: 'start' }, authorize()])
  assert.equal(connectShowsSlowProviderNote(waiting), false)

  const slow = connectReducer(waiting, {
    elapsedMs: CONNECT_STILL_WAITING_MS,
    type: 'waited',
  })
  assert.equal(slow.phase, 'awaiting_authorization')
  assert.equal(connectShowsSlowProviderNote(slow), true)

  const expired = connectReducer(slow, {
    elapsedMs: CONNECT_AUTHORIZATION_TIMEOUT_MS,
    type: 'waited',
  })
  assert.equal(expired.phase, 'error')
  assert.equal(expired.error?.code, 'AUTH_EXPIRED')
})

test('a blocked window is a state to render, not a dead end', () => {
  const blocked = run([{ type: 'start' }, authorize(), { opened: false, type: 'launcher_result' }])
  assert.equal(blocked.phase, 'awaiting_authorization')
  assert.equal(blocked.popupBlocked, true)
  assert.equal(blocked.authorizationUrl, 'https://github.com/login/oauth/authorize?x=1')
})

test('late signals from a finished flow cannot repaint it', () => {
  const connected = run([
    { type: 'start' },
    { result: { connectionId: 'conn-1', status: 'connected' }, type: 'server_result' },
  ])
  assert.equal(connectReducer(connected, { opened: false, type: 'launcher_result' }), connected)
  assert.equal(connectReducer(connected, { type: 'authorization_closed' }), connected)
  assert.equal(
    connectReducer(connected, { elapsedMs: CONNECT_AUTHORIZATION_TIMEOUT_MS, type: 'waited' }),
    connected,
  )

  const failedState = run([
    { type: 'start' },
    { code: 'SERVER_UNREACHABLE', detail: null, type: 'failed' },
  ])
  assert.equal(
    connectReducer(failedState, { connected: true, type: 'connection_observed' }),
    failedState,
  )
})

test('a flow the page walked away from resumes as waiting, not as idle', () => {
  const resumed = connectReducer(initialConnectState, {
    authorizationUrl: 'https://idp.example/authorize',
    connectionId: 'conn-9',
    type: 'resume',
    waitedMs: 30_000,
  })
  assert.equal(resumed.phase, 'awaiting_authorization')
  assert.equal(resumed.requiresAuthorization, true)
  assert.equal(resumed.waitedMs, 30_000)
  assert.equal(connectShowsSlowProviderNote(resumed), true)
})

// ─── The step list ──────────────────────────────────────────────────────────

test('the step list names a sign-in only for an app that asked for one', () => {
  const noAuth = run([{ type: 'start' }])
  assert.deepEqual(
    connectSteps(noAuth, 'GitHub').map((step) => [step.id, step.status]),
    [['check', 'active'], ['capabilities', 'pending']],
  )

  const waiting = run([{ type: 'start' }, authorize()])
  assert.deepEqual(
    connectSteps(waiting, 'GitHub').map((step) => [step.id, step.status]),
    [['check', 'done'], ['authorize', 'active'], ['capabilities', 'pending']],
  )
  assert.equal(connectSteps(waiting, 'GitHub')[1]?.label, 'Signing in to GitHub…')

  const verifying = connectReducer(waiting, { ok: true, type: 'authorization_reported' })
  assert.deepEqual(
    connectSteps(verifying, 'GitHub').map((step) => [step.id, step.status]),
    [['check', 'done'], ['authorize', 'done'], ['capabilities', 'active']],
  )
})

test('idle, needs_secret and error render no steps — each has its own copy', () => {
  assert.deepEqual(connectSteps(initialConnectState, 'GitHub'), [])
  const errored = run([{ type: 'start' }, { code: 'SERVER_INVALID', detail: null, type: 'failed' }])
  assert.deepEqual(connectSteps(errored, 'GitHub'), [])
})

// ─── Error copy ─────────────────────────────────────────────────────────────

test('cancelling reads as information and offers the way back', () => {
  const presentation = connectErrorPresentation('AUTH_CANCELLED', { appName: 'GitHub' })
  assert.equal(presentation.tone, 'info')
  assert.equal(presentation.retryLabel, 'Try again')
  assert.match(presentation.message, /^Connection cancelled\./)
})

test('an error whose sentence names another action does not also offer retry', () => {
  const presentation = connectErrorPresentation('CAPABILITY_DISCOVERY_FAILED', {
    appName: 'Linear',
  })
  assert.equal(presentation.retryLabel, null)
  assert.match(presentation.message, /Manage menu/)
  assert.match(presentation.message, /^Linear connected/)
})

test('the app is named where the app failed and the provider where sign-in did', () => {
  const server = connectErrorPresentation('SERVER_UNREACHABLE', {
    appName: 'Acme Docs',
    providerName: 'Okta',
  })
  assert.match(server.message, /We couldn’t reach Acme Docs’s server\./)

  const auth = connectErrorPresentation('AUTH_FAILED', {
    appName: 'Acme Docs',
    providerName: 'Okta',
  })
  assert.match(auth.message, /^Okta didn’t accept the sign-in\./)

  // With no separate provider the app's own name stands in, so the sentence
  // never says "undefined didn't accept the sign-in".
  const fallback = connectErrorPresentation('AUTH_FAILED', { appName: 'Acme Docs' })
  assert.match(fallback.message, /^Acme Docs didn’t accept the sign-in\./)
})

test('every code has a sentence with a next action and a tone', () => {
  const codes = [
    'AUTH_CANCELLED', 'AUTH_EXPIRED', 'AUTH_FAILED', 'SERVER_UNREACHABLE', 'SERVER_INVALID',
    'MCP_INITIALIZATION_FAILED', 'CAPABILITY_DISCOVERY_FAILED', 'OAUTH_DISCOVERY_FAILED',
    'CLIENT_REGISTRATION_FAILED', 'CONNECTION_FAILED',
  ] as const
  for (const code of codes) {
    const presentation = connectErrorPresentation(code, { appName: 'GitHub' })
    assert.ok(presentation.message.length > 20, code)
    assert.ok(presentation.tone === 'danger' || presentation.tone === 'info', code)
  }
})

// ─── The pending marker ─────────────────────────────────────────────────────

test('a marker round-trips and is scoped to one app', () => {
  assert.equal(connectMarkerKey('github'), 'nessie.apps.connect.github')
  const now = 1_700_000_000_000
  const raw = serializeConnectMarker({
    authorizationUrl: 'https://idp.example/authorize',
    connectionId: 'conn-1',
    startedAt: now,
  })
  assert.deepEqual(parseConnectMarker(raw, now + 5_000), {
    authorizationUrl: 'https://idp.example/authorize',
    connectionId: 'conn-1',
    startedAt: now,
  })
})

test('a marker older than a live sign-in is discarded, not resumed', () => {
  const now = 1_700_000_000_000
  const raw = serializeConnectMarker({
    authorizationUrl: null,
    connectionId: 'conn-1',
    startedAt: now,
  })
  assert.equal(parseConnectMarker(raw, now + CONNECT_AUTHORIZATION_TIMEOUT_MS), null)
  // A clock that moved backwards is not a fresh marker either.
  assert.equal(parseConnectMarker(raw, now - 1), null)
})

test('a corrupt or hostile marker never survives to be opened', () => {
  const now = 1_700_000_000_000
  assert.equal(parseConnectMarker(null, now), null)
  assert.equal(parseConnectMarker('{', now), null)
  assert.equal(parseConnectMarker(JSON.stringify({ startedAt: now }), now), null)
  const injected = JSON.stringify({
    authorizationUrl: 'javascript:alert(1)',
    connectionId: 'conn-1',
    startedAt: now,
  })
  assert.equal(parseConnectMarker(injected, now)?.authorizationUrl, null)
})

// ─── The sign-in window ─────────────────────────────────────────────────────

const host = (overrides: Partial<{
  opened: ExternalAuthWindow | null
  outerHeight: number
  outerWidth: number
  screenX: number
  screenY: number
}> = {}) => {
  const calls: { features: string; target: string; url: string }[] = []
  const opened = 'opened' in overrides ? overrides.opened ?? null : { closed: false, close: () => {}, focus: () => {} }
  return {
    calls,
    host: {
      open: (url: string, target: string, features: string) => {
        calls.push({ features, target, url })
        return opened
      },
      outerHeight: overrides.outerHeight ?? 1000,
      outerWidth: overrides.outerWidth ?? 1400,
      screenX: overrides.screenX ?? 0,
      screenY: overrides.screenY ?? 0,
    },
    opened,
  }
}

test('the sign-in window is centred on the window the person is looking at', () => {
  // A second monitor sits at x=1440; centring on the screen would open there.
  const features = authPopupFeatures({
    outerHeight: 1000,
    outerWidth: 1400,
    screenX: 1440,
    screenY: 100,
  })
  assert.match(features, /width=600/)
  assert.match(features, /height=760/)
  assert.match(features, /left=1840/)
  assert.match(features, /top=220/)
})

test('a window smaller than the popup still opens on screen', () => {
  const features = authPopupFeatures({
    outerHeight: 400,
    outerWidth: 400,
    screenX: 0,
    screenY: 0,
  })
  assert.match(features, /left=0/)
  assert.match(features, /top=0/)
})

test('opening yields a handle that reports closure; a blocked open yields null', () => {
  const popup = { closed: false, close: () => { popup.closed = true }, focus: () => {} }
  const opener = host({ opened: popup })
  const handle = createWindowAuthLauncher(opener.host).open('https://idp.example/authorize')
  assert.ok(handle)
  assert.equal(opener.calls[0]?.url, 'https://idp.example/authorize')
  assert.equal(opener.calls[0]?.target, 'nessie-connect')
  // Never `noopener`: it would return null and cut the callback's opener.
  assert.doesNotMatch(opener.calls[0]?.features ?? '', /noopener/)

  assert.equal(handle.isClosed(), false)
  handle.close()
  assert.equal(handle.isClosed(), true)

  const blocked = createWindowAuthLauncher(host({ opened: null }).host)
  assert.equal(blocked.open('https://idp.example/authorize'), null)
})
