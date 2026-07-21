import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ConnectorConnectionContext } from '@nessie/comms-connect'

import { createGoogleConnector } from '../src/connector.js'
import {
  decodeIncrementalCursor,
  type GoogleConnectorDeps,
} from '../src/config.js'
import {
  GmailApiError,
  GmailHistoryExpiredError,
  GmailReauthorizationRequiredError,
} from '../src/errors.js'
import type { FetchLike } from '../src/http.js'

type Route = { status: number; body: unknown }
type Handler = (url: string, method: string) => Route

const makeFetch = (handler: Handler): FetchLike =>
  async (url, init) => {
    const { status, body } = handler(url, init?.method ?? 'GET')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }

const baseDeps = (fetchImpl: FetchLike): GoogleConnectorDeps => ({
  fetch: fetchImpl,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  pubsubTopic: 'projects/p/topics/t',
  now: () => 1_700_000_000_000,
})

const connection = (
  overrides: Partial<ConnectorConnectionContext> = {},
): ConnectorConnectionContext => ({
  id: 'conn-1',
  organizationId: 'org-1',
  ownerUserId: 'user-1',
  provider: 'google',
  externalTenantId: 'me@example.com',
  externalUserId: 'me@example.com',
  credential: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  ...overrides,
})

test('connect exchanges the code and resolves the mailbox identity', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/token')) {
      return {
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b' },
      }
    }
    if (url.endsWith('/profile')) {
      return { status: 200, body: { emailAddress: 'me@example.com', historyId: '42' } }
    }
    throw new Error(`unexpected url ${url}`)
  })
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  const result = await connector.connect({
    organizationId: 'org-1',
    userId: 'user-1',
    provider: 'google',
    code: 'auth-code',
    redirectUri: 'https://app/callback',
    statePayload: { codeVerifier: 'verifier' },
  })
  assert.equal(result.externalTenantId, 'me@example.com')
  assert.equal(result.externalUserId, 'me@example.com')
  assert.deepEqual(result.grantedScopes, ['a', 'b'])
  assert.equal(result.credential.accessToken, 'at')
  assert.equal(result.credential.refreshToken, 'rt')
})

test('refresh classifies invalid_grant as reauthorization required', async () => {
  const fetchImpl = makeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }))
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  await assert.rejects(
    () => connector.refreshCredentials(connection()),
    GmailReauthorizationRequiredError,
  )
})

test('a 429 surfaces as a retryable GmailApiError', async () => {
  const fetchImpl = makeFetch(() => ({
    status: 429,
    body: { error: { message: 'rateLimitExceeded' } },
  }))
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  await assert.rejects(connector.discoverResources(connection()), (error: unknown) => {
    assert.ok(error instanceof GmailApiError)
    assert.equal(error.status, 429)
    assert.equal(error.retryable, true)
    return true
  })
})

test('incremental sync seeds the baseline historyId on first run', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/profile')) {
      return { status: 200, body: { emailAddress: 'me@example.com', historyId: '100' } }
    }
    throw new Error(`unexpected url ${url}`)
  })
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  const result = await connector.runIncrementalSync(connection(), {})
  assert.deepEqual(result.events, [])
  assert.equal(result.hasMore, false)
  assert.equal(decodeIncrementalCursor(result.checkpoint.cursor).historyId, '100')
})

test('incremental sync raises GmailHistoryExpiredError on a 404 history', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.includes('/history')) {
      return { status: 404, body: { error: { message: 'historyId expired' } } }
    }
    throw new Error(`unexpected url ${url}`)
  })
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  await assert.rejects(
    () =>
      connector.runIncrementalSync(connection(), {
        cursor: JSON.stringify({ historyId: '5' }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof GmailHistoryExpiredError)
      assert.equal(error.staleHistoryId, '5')
      assert.equal(error.emailAddress, 'me@example.com')
      return true
    },
  )
})

test('discoverResources turns labels into resources, SPAM/TRASH off', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/labels')) {
      return {
        status: 200,
        body: {
          labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'SPAM', name: 'Spam', type: 'system' },
            { id: 'Label_1', name: 'Work', type: 'user' },
          ],
        },
      }
    }
    throw new Error(`unexpected url ${url}`)
  })
  const connector = createGoogleConnector(baseDeps(fetchImpl))
  const resources = await connector.discoverResources(connection())
  const byId = new Map(resources.map((r) => [r.externalId, r]))
  assert.equal(byId.get('INBOX')?.syncEnabled, true)
  assert.equal(byId.get('SPAM')?.syncEnabled, false)
  assert.equal(byId.get('Label_1')?.resourceType, 'mailbox_label')
  assert.equal(byId.get('Label_1')?.visibility, 'private-mailbox')
})
