import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  type BoardSourceAdapter,
  clearBoardSourceAdapters,
  registerBoardSourceAdapter,
} from '@nessie/board-sources'
import { sealSecret } from '@nessie/runtime'

import { buildWebhookCallback, webhookCallbackUrl } from '../src/control/board-source-sync.js'
import { processBoardSourceWebhook } from '../src/control/board-source-webhook.js'

/**
 * A deployment that registered no app-level webhook secret must still verify
 * the deliveries its own registration asked for — that is the whole reason a
 * source registers its own callback. What makes it work is the secret travelling
 * from `ensureWebhook` into the row and back out at verification time, and
 * nothing type-checks that round trip: `WebhookRegistration.signingSecret` is
 * optional, so dropping it compiles and silently downgrades every board to
 * polling.
 */

const ENCRYPTION_SECRET = 'test-encryption-secret'
const PUBLIC_API_URL = 'https://nessie.example'

const sourceRow = (over: Record<string, unknown> = {}) => ({
  id: 'source-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  provider: 'linear' as const,
  container: { teamId: 'team-1' },
  connectionId: 'connection-1',
  containerKey: 'team-1',
  stateMapping: [],
  fieldMappings: [],
  webhookTokenHash: null,
  webhookSecretCiphertext: null,
  connection: { externalTenantId: 'tenant-1' },
  ...over,
})

/** Records what verification was handed, and never applies anything. */
const stubAdapter = (seen: { secrets: unknown[] }): BoardSourceAdapter =>
  ({
    provider: 'linear',
    allowedHosts: ['api.linear.app'],
    auth: { apiKey: { form: { createUrl: 'x', createLabel: 'x', fields: [] }, verify: async () => {
      throw new Error('unused')
    } } },
    parseWebhook: () => ({ deliveryId: 'd1', containerKey: 'team-1', externalIds: ['issue-1'] }),
    verifyWebhook: (request, secrets) => {
      seen.secrets.push(secrets)
      const signature = request.headers['linear-signature']
      if (!signature || !secrets.signingSecret) return false
      return (
        signature ===
        createHmac('sha256', secrets.signingSecret).update(request.rawBody).digest('hex')
      )
    },
    // Reached only when verification passed, which is what the assertions read.
    fetchItems: async () => [],
    listContainers: async () => [],
    describeContainer: async () => ({ states: [], fields: [], members: [] }),
    fetchPage: async () => ({ items: [], hasMore: false, checkpoint: { phase: 'incremental' } }),
    ensureWebhook: async () => null,
    applyChange: async () => {
      throw new Error('unused')
    },
  }) as unknown as BoardSourceAdapter

const buildDeps = (rows: ReturnType<typeof sourceRow>[]) => ({
  prisma: {
    boardSource: { findMany: async () => rows },
    // Verification is what these tests read, and it happens before the
    // credential is loaded — so the connection is deliberately absent, which
    // stops the delivery one step later with CONNECTION_NOT_FOUND rather than
    // needing a whole encrypted credential fixture.
    boardSourceConnection: { findUnique: async () => null },
  } as unknown as PrismaClient,
  encryptionSecret: ENCRYPTION_SECRET,
  publicApiUrl: PUBLIC_API_URL,
  enqueueHealthAlert: async () => {},
  publishBoardUpdated: async () => {},
})

test('a delivery verifies against the secret this source’s own registration returned', async () => {
  const seen: { secrets: unknown[] } = { secrets: [] }
  clearBoardSourceAdapters()
  registerBoardSourceAdapter('linear', () => stubAdapter(seen))

  const rawBody = JSON.stringify({ action: 'update', data: { id: 'issue-1' } })
  const deps = buildDeps([
    sourceRow({
      webhookSecretCiphertext: sealSecret(ENCRYPTION_SECRET, 'minted-by-linear'),
    }),
  ])

  await processBoardSourceWebhook(deps, {
    provider: 'linear',
    headers: {
      'linear-signature': createHmac('sha256', 'minted-by-linear').update(rawBody).digest('hex'),
    },
    rawBody,
    token: 'callback-token',
  })

  const [secrets] = seen.secrets as { signingSecret?: string; callbackUrl?: string }[]
  assert.equal(secrets?.signingSecret, 'minted-by-linear')
  // Trello signs `body + callbackURL`, so the URL is rebuilt from the
  // delivery's own token rather than stored — a second stored spelling could
  // drift from the URL the provider is actually calling.
  assert.equal(
    secrets?.callbackUrl,
    'https://nessie.example/api/board-sources/webhooks/linear/callback-token',
  )
  clearBoardSourceAdapters()
})

test('a source that never registered one is handed no secret to verify against', async () => {
  const seen: { secrets: unknown[] } = { secrets: [] }
  clearBoardSourceAdapters()
  registerBoardSourceAdapter('linear', () => stubAdapter(seen))

  await processBoardSourceWebhook(buildDeps([sourceRow()]), {
    provider: 'linear',
    headers: { 'linear-signature': 'anything' },
    rawBody: '{}',
    token: 'callback-token',
  })

  const [secrets] = seen.secrets as { signingSecret?: string }[]
  // Absent rather than empty-string: an adapter falls back to the deployment's
  // app-level secret on `?? config.webhookSecret`, and '' would defeat that.
  assert.equal('signingSecret' in (secrets ?? {}), false)
  clearBoardSourceAdapters()
})

test('every registration is offered a fresh secret and a fresh callback', () => {
  const first = buildWebhookCallback({ publicApiUrl: PUBLIC_API_URL }, 'linear', 'token-a')
  const second = buildWebhookCallback({ publicApiUrl: PUBLIC_API_URL }, 'linear', 'token-b')

  assert.equal(first.url, webhookCallbackUrl(PUBLIC_API_URL, 'linear', 'token-a'))
  assert.equal(first.token, 'token-a')
  // A re-registration must rotate away from a leaked callback rather than
  // re-blessing it, so neither half may be reused.
  assert.notEqual(first.secret, second.secret)
  assert.ok(first.secret.length >= 32)
})
