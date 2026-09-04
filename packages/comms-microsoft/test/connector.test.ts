import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConnectorConnectionContext } from '@nessie/comms-connect'

import { createMicrosoftConnector } from '../src/connector.js'
import type { MicrosoftConnectorDeps } from '../src/config.js'
import {
  MicrosoftApiError,
  MicrosoftIdentityError,
  MicrosoftReauthorizationRequiredError,
} from '../src/index.js'
import { assertGraphPageUrl, type FetchLike } from '../src/http.js'
import { normalizeMicrosoftMessage } from '../src/normalize.js'
import { decodeMicrosoftDeltaCursor } from '../src/sync.js'

const NOW_MS = 1_700_000_000_000
const NONCE = 'n'.repeat(32)
const VERIFIER = 'v'.repeat(43)

type Route = { status: number; body: unknown }
type Handler = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Route

const makeFetch = (handler: Handler): FetchLike => async (url, init) => {
  const result = handler(url, init ?? {})
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.body,
    text: async () => JSON.stringify(result.body),
  }
}

const idToken = (claims: Record<string, unknown> = {}): string => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = {
    iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
    aud: 'client-id',
    tid: 'tenant-1',
    oid: 'graph-user-1',
    nonce: NONCE,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    ...claims,
  }
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`
}

const deps = (fetch: FetchLike): MicrosoftConnectorDeps => ({
  fetch,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  pageSize: 2,
  now: () => NOW_MS,
})

const connection = (
  overrides: Partial<ConnectorConnectionContext> = {},
): ConnectorConnectionContext => ({
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  ownerUserId: '33333333-3333-3333-3333-333333333333',
  provider: 'microsoft',
  externalTenantId: 'tenant-1',
  externalUserId: 'me@example.com',
  credential: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['Mail.Read'],
  },
  ...overrides,
})

const callback = () => ({
  organizationId: 'org-1',
  userId: 'user-1',
  provider: 'microsoft' as const,
  code: 'authorization-code',
  redirectUri: 'https://api.example.test/api/comms/connections/microsoft/callback',
  statePayload: { codeVerifier: VERIFIER, nonce: NONCE },
})

test('exchanges code with exact redirect + PKCE and proves identity through Graph', async () => {
  let tokenBody = ''
  const connector = createMicrosoftConnector(deps(makeFetch((url, init) => {
    if (url.endsWith('/token')) {
      tokenBody = init.body ?? ''
      return {
        status: 200,
        body: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'Mail.Read User.Read openid profile email offline_access',
          id_token: idToken(),
        },
      }
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) {
      return {
        status: 200,
        body: {
          id: 'graph-user-1',
          mail: 'Me@Example.COM',
          userPrincipalName: 'ignored@example.com',
        },
      }
    }
    throw new Error(`unexpected URL ${url}`)
  })))

  const result = await connector.connect(callback())
  const fields = new URLSearchParams(tokenBody)
  assert.equal(fields.get('code_verifier'), VERIFIER)
  assert.equal(fields.get('redirect_uri'), callback().redirectUri)
  assert.equal(fields.get('client_secret'), 'client-secret')
  assert.equal(result.externalTenantId, 'tenant-1')
  assert.equal(result.providerAccountId, 'graph-user-1')
  assert.equal(result.externalUserId, 'me@example.com')
  assert.ok(result.grantedScopes.includes('Mail.Read'))
  assert.ok(!result.grantedScopes.includes('Mail.Send'))
})

test('refuses a replayed/mismatched OIDC nonce before persisting identity', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.endsWith('/token')) {
      return {
        status: 200,
        body: { access_token: 'at', scope: 'Mail.Read', id_token: idToken({ nonce: 'wrong' }) },
      }
    }
    throw new Error('Graph must not be called for mismatched nonce')
  })))
  await assert.rejects(() => connector.connect(callback()), MicrosoftIdentityError)
})

test('refuses an OIDC object id that does not match Graph /me', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.endsWith('/token')) {
      return { status: 200, body: { access_token: 'at', scope: 'Mail.Read', id_token: idToken() } }
    }
    return { status: 200, body: { id: 'different-graph-id', mail: 'me@example.com' } }
  })))
  await assert.rejects(() => connector.connect(callback()), MicrosoftIdentityError)
})

test('rejects a non-mail UPN instead of treating it as a connection address', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.endsWith('/token')) {
      return { status: 200, body: { access_token: 'at', scope: 'Mail.Read', id_token: idToken() } }
    }
    return { status: 200, body: { id: 'graph-user-1', userPrincipalName: 'not-an-email' } }
  })))
  await assert.rejects(() => connector.connect(callback()), MicrosoftIdentityError)
})

test('refresh rotates a replacement refresh token and preserves scopes when omitted', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch(() => ({
    status: 200,
    body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 120 },
  }))))
  const refreshed = await connector.refreshCredentials(connection())
  assert.equal(refreshed.accessToken, 'access-2')
  assert.equal(refreshed.refreshToken, 'refresh-2')
  assert.deepEqual(refreshed.scopes, ['Mail.Read'])
})

test('missing or rejected refresh grants require reauthorization', async () => {
  const missing = createMicrosoftConnector(deps(makeFetch(() => {
    throw new Error('must not fetch without a refresh token')
  })))
  await assert.rejects(
    () => missing.refreshCredentials(connection({ credential: { accessToken: 'at', scopes: [] } })),
    MicrosoftReauthorizationRequiredError,
  )

  const rejected = createMicrosoftConnector(deps(makeFetch(() => ({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'never retained' },
  }))))
  await assert.rejects(
    () => rejected.refreshCredentials(connection()),
    MicrosoftReauthorizationRequiredError,
  )
})

test('classifies a token-endpoint consent policy denial without retaining its description', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch(() => ({
    status: 400,
    body: { error: 'consent_required', error_description: 'not retained' },
  }))))
  await assert.rejects(connector.connect(callback()), (error: unknown) => {
    assert.ok(error instanceof MicrosoftApiError)
    assert.equal(error.authorizationBlocked, true)
    assert.equal(error.needsReauthorization, false)
    assert.equal(error.message.includes('not retained'), false)
    return true
  })
})

test('rejects Graph continuations outside the fixed public Graph API origin', () => {
  assert.throws(
    () => assertGraphPageUrl('https://127.0.0.1/v1.0/me/messages/delta'),
    /unsafe page URL/,
  )
})

test('discovers Graph folders and classifies auth and policy failures structurally', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.includes('mailFolders')) {
      return {
        status: 200,
        body: { value: [{ id: 'inbox', displayName: 'Inbox', wellKnownName: 'inbox' }] },
      }
    }
    throw new Error(`unexpected ${url}`)
  })))
  const resources = await connector.discoverResources(connection())
  assert.deepEqual(resources[0], {
    resourceType: 'mail_folder',
    externalId: 'inbox',
    name: 'Inbox',
    visibility: 'private-mailbox',
    userHasAccess: true,
    syncEnabled: true,
  })

  const rejected = createMicrosoftConnector(deps(makeFetch(() => ({
    status: 401,
    body: { error: { code: 'InvalidAuthenticationToken', message: 'not retained' } },
  }))))
  await assert.rejects(rejected.discoverResources(connection()), (error: unknown) => {
    assert.ok(error instanceof MicrosoftApiError)
    assert.equal(error.needsReauthorization, true)
    assert.equal(error.retryable, false)
    return true
  })

  const blocked = createMicrosoftConnector(deps(makeFetch(() => ({
    status: 403,
    body: { error: { code: 'Authorization_RequestDenied', message: 'not retained' } },
  }))))
  await assert.rejects(blocked.discoverResources(connection()), (error: unknown) => {
    assert.ok(error instanceof MicrosoftApiError)
    assert.equal(error.authorizationBlocked, true)
    assert.equal(error.retryable, false)
    return true
  })
})

test('uses per-folder Graph delta pages, persists opaque links and imports text only', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = []
  const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next'
  const deltaLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=final'
  let deltaCalls = 0
  const connector = createMicrosoftConnector(deps(makeFetch((url, init) => {
    seen.push({ url, headers: init.headers })
    if (url.includes('/mailFolders?')) {
      return {
        status: 200,
        body: {
          value: [
            { id: 'inbox', displayName: 'Inbox', wellKnownName: 'inbox' },
            { id: 'junk', displayName: 'Junk', wellKnownName: 'junkemail' },
          ],
        },
      }
    }
    deltaCalls += 1
    if (deltaCalls === 1) {
      return {
        status: 200,
        body: {
          value: [{
            id: 'message-1',
            conversationId: 'conversation-1',
            subject: 'Status',
            bodyPreview: 'preview',
            body: { contentType: 'text', content: 'plain provider text' },
            from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } },
            toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
            receivedDateTime: '2026-01-01T00:00:00Z',
          }],
          '@odata.nextLink': nextLink,
        },
      }
    }
    if (deltaCalls === 2) return { status: 200, body: { value: [], '@odata.deltaLink': deltaLink } }
    return {
      status: 200,
      body: {
        value: [{ id: 'message-1', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': deltaLink,
      },
    }
  })))

  const first = await connector.runInitialSync(connection())
  assert.equal(first.hasMore, true)
  assert.equal(first.events[0]?.contentText, 'plain provider text')
  assert.equal(first.events[0]?.contentHtml, undefined)
  assert.equal(first.events[0]?.canonicalMessageId, 'microsoft:tenant-1:message-1:message-1')
  assert.equal(seen.at(-1)?.headers?.Prefer, 'outlook.body-content-type="text"')
  assert.equal(decodeMicrosoftDeltaCursor(first.checkpoint.cursor)?.folders[0]?.pageLink, nextLink)

  const second = await connector.runInitialSync(connection(), first.checkpoint)
  assert.equal(second.hasMore, false)
  assert.equal(decodeMicrosoftDeltaCursor(second.checkpoint.cursor)?.folders[0]?.deltaLink, deltaLink)

  const incremental = await connector.runIncrementalSync(connection(), second.checkpoint)
  assert.equal(incremental.hasMore, false)
  assert.equal(incremental.events[0]?.isDeleted, true)
  assert.equal(incremental.events[0]?.canonicalMessageId, first.events[0]?.canonicalMessageId)
})

test('never normalizes a Graph HTML body when text preference is disregarded', () => {
  const event = normalizeMicrosoftMessage('tenant-1', {
    id: 'html-message',
    conversationId: 'conversation',
    body: { contentType: 'html', content: '<script>unsafe()</script>' },
    bodyPreview: 'safe preview',
    receivedDateTime: '2026-01-01T00:00:00Z',
  })
  assert.equal(event.contentText, 'safe preview')
  assert.equal(event.contentHtml, undefined)
})

test('an incremental job with its own empty checkpoint establishes a delta baseline', async () => {
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.includes('/mailFolders?')) {
      return { status: 200, body: { value: [{ id: 'inbox', wellKnownName: 'inbox' }] } }
    }
    return {
      status: 200,
      body: {
        value: [{
          id: 'baseline-message',
          conversationId: 'conversation',
          body: { contentType: 'text', content: 'already imported safely' },
          receivedDateTime: '2026-01-01T00:00:00Z',
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=baseline',
      },
    }
  })))
  const result = await connector.runIncrementalSync(connection(), {})
  assert.equal(result.hasMore, false)
  assert.equal(result.events[0]?.messageId, 'baseline-message')
  assert.equal(decodeMicrosoftDeltaCursor(result.checkpoint.cursor)?.kind, 'incremental')
})

test('an incremental bootstrap advances initial cursors across delta pages and folders', async () => {
  const inboxNext = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=inbox'
  const inboxDelta = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=inbox'
  const archiveDelta = 'https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=archive'
  let deltaCalls = 0
  const connector = createMicrosoftConnector(deps(makeFetch((url) => {
    if (url.includes('/mailFolders?')) {
      return {
        status: 200,
        body: {
          value: [
            { id: 'inbox', wellKnownName: 'inbox' },
            { id: 'archive', wellKnownName: 'archive' },
          ],
        },
      }
    }
    deltaCalls += 1
    if (deltaCalls === 1) {
      return { status: 200, body: { value: [], '@odata.nextLink': inboxNext } }
    }
    if (deltaCalls === 2) {
      assert.equal(url, inboxNext)
      return { status: 200, body: { value: [], '@odata.deltaLink': inboxDelta } }
    }
    assert.match(url, /mailFolders\/archive\/messages\/delta/)
    return { status: 200, body: { value: [], '@odata.deltaLink': archiveDelta } }
  })))

  const first = await connector.runIncrementalSync(connection(), {})
  assert.equal(first.hasMore, true)
  assert.equal(decodeMicrosoftDeltaCursor(first.checkpoint.cursor)?.kind, 'initial')

  const second = await connector.runIncrementalSync(connection(), first.checkpoint)
  assert.equal(second.hasMore, true)
  assert.equal(decodeMicrosoftDeltaCursor(second.checkpoint.cursor)?.folderIndex, 1)

  const final = await connector.runIncrementalSync(connection(), second.checkpoint)
  assert.equal(final.hasMore, false)
  assert.equal(decodeMicrosoftDeltaCursor(final.checkpoint.cursor)?.kind, 'incremental')
  assert.equal(deltaCalls, 3)
})
