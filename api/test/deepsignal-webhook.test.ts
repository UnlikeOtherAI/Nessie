import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  ProductWebhookSecretError,
  resolveSignedWebhookOrg,
  setProductWebhookSecret,
} from '../src/services/product-webhook-secret.js'
import { handleDeepSignalInsightSurfaced } from '../src/services/deepsignal-webhook.js'

const AUTH_SECRET = 'test-auth-secret-000000000000000000'
const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'

// ─── Webhook signing secret store (HMAC accept/reject) ──────────────────────

type SecretRow = { organizationId: string; productSlug: string; ciphertext: string; iv: string; authTag: string }

const makeSecretFake = () => {
  const rows: SecretRow[] = []
  return {
    rows,
    productWebhookSecret: {
      upsert: async (args: {
        where: { organizationId_productSlug: { organizationId: string; productSlug: string } }
        create: SecretRow
        update: { ciphertext: string; iv: string; authTag: string }
      }) => {
        const key = args.where.organizationId_productSlug
        const existing = rows.find(
          (r) => r.organizationId === key.organizationId && r.productSlug === key.productSlug,
        )
        if (existing) Object.assign(existing, args.update)
        else rows.push({ ...args.create })
        return {}
      },
      findMany: async (args: { where: { productSlug: string } }) =>
        rows.filter((r) => r.productSlug === args.where.productSlug),
    },
  }
}

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

test('webhook signature: valid HMAC resolves the signing org, tampered body is rejected', async () => {
  const fake = makeSecretFake()
  const prisma = fake as unknown as PrismaClient
  const secret = 'deepsignal-shared-signing-secret-01'
  await setProductWebhookSecret(prisma, AUTH_SECRET, {
    organizationId: ORG,
    productSlug: 'deepsignal',
    secret,
  })
  // A different org holds a different secret for the same product.
  await setProductWebhookSecret(prisma, AUTH_SECRET, {
    organizationId: OTHER_ORG,
    productSlug: 'deepsignal',
    secret: 'a-totally-different-secret-value-02',
  })

  const body = JSON.stringify({ event: 'insight.surfaced', insightId: 'i1' })

  const matched = await resolveSignedWebhookOrg(prisma, AUTH_SECRET, {
    productSlug: 'deepsignal',
    rawBody: Buffer.from(body),
    signatureHeader: sign(secret, body),
  })
  assert.equal(matched, ORG)

  const tampered = await resolveSignedWebhookOrg(prisma, AUTH_SECRET, {
    productSlug: 'deepsignal',
    rawBody: Buffer.from(body + ' '),
    signatureHeader: sign(secret, body),
  })
  assert.equal(tampered, null, 'signature over different bytes must not verify')

  const missing = await resolveSignedWebhookOrg(prisma, AUTH_SECRET, {
    productSlug: 'deepsignal',
    rawBody: Buffer.from(body),
    signatureHeader: undefined,
  })
  assert.equal(missing, null)

  const garbage = await resolveSignedWebhookOrg(prisma, AUTH_SECRET, {
    productSlug: 'deepsignal',
    rawBody: Buffer.from(body),
    signatureHeader: 'sha256=not-hex',
  })
  assert.equal(garbage, null)
})

test('webhook signing secret cannot reuse the DeepSignal application key', async () => {
  const prior = process.env.DEEPSIGNAL_MCP_APP_KEY
  const appKey = `dsk_${'n'.repeat(32)}`
  process.env.DEEPSIGNAL_MCP_APP_KEY = appKey
  try {
    await assert.rejects(
      setProductWebhookSecret(
        makeSecretFake() as unknown as PrismaClient,
        AUTH_SECRET,
        {
          organizationId: ORG,
          productSlug: 'deepsignal',
          secret: appKey,
        },
      ),
      (error: unknown) =>
        error instanceof ProductWebhookSecretError
        && error.code === 'PRODUCT_WEBHOOK_SECRET_REUSES_APP_CREDENTIAL',
    )
  } finally {
    if (prior === undefined) {
      delete process.env.DEEPSIGNAL_MCP_APP_KEY
    } else {
      process.env.DEEPSIGNAL_MCP_APP_KEY = prior
    }
  }
})

// ─── Insight fan-out + idempotency ──────────────────────────────────────────

type Link = { organizationId: string; userId: string; productSlug: string; status: string; uoaSub: string | null }
type StoredMessage = {
  id: string
  threadId: string
  role: string
  agentId: string | null
  content: string
  createdAt: Date
  deletedAt: Date | null
  metadata: Record<string, unknown>
}

const messageInsightIds = (message: StoredMessage): string[] =>
  ((message.metadata.external as { insights?: Array<{ insightId: string }> })?.insights ?? []).map(
    (entry) => entry.insightId,
  )

const USER_A = '00000000-0000-4000-8000-0000000000b1'
const USER_B = '00000000-0000-4000-8000-0000000000b2'

const digestInsights = (message: StoredMessage): Array<{ insightId: string; kind: string | null }> =>
  ((message.metadata.external as { insights?: Array<{ insightId: string; kind: string | null }> })
    ?.insights ?? [])

// Prisma fake for the digest delivery path: a `messages` array with findMany
// (Json path + createdAt window), create, and in-place update. `clock` is the
// simulated wall time each created row is stamped with, advanced by the test.
const makeInsightFake = (links: Link[]) => {
  const messages: StoredMessage[] = []
  const state = { clock: new Date('2026-07-12T00:00:00.000Z') }
  const channels = new Map<string, { id: string; archivedAt: Date | null }>()
  for (const link of links) {
    channels.set(`extagent:deepsignal:${link.organizationId}:${link.userId}`, {
      id: `chan-${link.userId}`,
      archivedAt: null,
    })
  }
  const client = {
    messages,
    state,
    productAccountLink: {
      findMany: async (args: {
        where: { organizationId: string; productSlug: string; status: string; uoaSub?: { in: string[] } }
      }) =>
        links
          .filter(
            (l) =>
              l.organizationId === args.where.organizationId &&
              l.productSlug === args.where.productSlug &&
              l.status === args.where.status &&
              (!args.where.uoaSub || args.where.uoaSub.in.includes(l.uoaSub ?? '')),
          )
          .map((l) => ({ userId: l.userId })),
    },
    channel: {
      findUnique: async (args: { where: { dmKey: string } }) => channels.get(args.where.dmKey) ?? null,
    },
    thread: {
      findFirst: async (args: { where: { channelId: string } }) => ({ id: `thread-${args.where.channelId}` }),
      create: async (args: { data: { channelId: string } }) => ({ id: `thread-${args.data.channelId}` }),
    },
    agentBinding: {
      findFirst: async () => ({ agentId: 'agent-ds' }),
    },
    $executeRaw: async () => 0,
    message: {
      // Unbounded dedupe: `metadata.external.insights[*].insightId` containment,
      // no time bound, non-deleted only.
      findFirst: async (args: {
        where: {
          threadId: string
          deletedAt: null
          metadata: { array_contains: Array<{ insightId: string }> }
        }
      }) => {
        const target = args.where.metadata.array_contains[0]!.insightId
        const match = messages.find(
          (m) =>
            m.threadId === args.where.threadId &&
            m.deletedAt === null &&
            messageInsightIds(m).includes(target),
        )
        return match ? { id: match.id } : null
      },
      findMany: async (args: {
        where: { threadId: string; deletedAt: null; createdAt: { gte: Date }; metadata: { equals: string } }
        orderBy: { createdAt: 'desc' }
      }) =>
        messages
          .filter(
            (m) =>
              m.threadId === args.where.threadId &&
              m.deletedAt === null &&
              m.createdAt.getTime() >= args.where.createdAt.gte.getTime() &&
              (m.metadata.external as { kind?: string })?.kind === args.where.metadata.equals,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async (args: { data: Omit<StoredMessage, 'id' | 'createdAt' | 'deletedAt'> }) => {
        const row: StoredMessage = {
          ...args.data,
          id: `msg-${messages.length + 1}`,
          createdAt: state.clock,
          deletedAt: null,
        }
        messages.push(row)
        return { id: row.id }
      },
      update: async (args: { where: { id: string }; data: Partial<StoredMessage> }) => {
        const row = messages.find((m) => m.id === args.where.id)!
        Object.assign(row, args.data)
        return { id: row.id }
      },
    },
  }
  // Interactive transaction: the fake is its own transaction client. Attached via
  // Object.assign (not the literal) so the closure over `client` isn't a
  // self-reference in the initializer.
  return Object.assign(client, {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  })
}

type InsightFake = ReturnType<typeof makeInsightFake>
const asPrisma = (fake: InsightFake): PrismaClient => fake as unknown as PrismaClient

const insightPayload = (insightId: string, extra: Record<string, unknown> = {}) => ({
  event: 'insight.surfaced',
  teamId: 'team-ds',
  insightId,
  actions: ['done', 'snooze', 'mute', 'reopen'],
  brief: {
    insightId,
    whatChanged: 'Supplier risk detected',
    whyItMatters: 'A key supplier may miss delivery',
    recommendedAction: 'Contact procurement',
    kind: 'risk',
    band: 'high',
  },
  ...extra,
})

test('insight fan-out coalesces multiple insights into one rolling digest per user', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
    { organizationId: ORG, userId: USER_B, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-b' },
    { organizationId: ORG, userId: 'x', productSlug: 'deepsignal', status: 'revoked', uoaSub: 'sub-x' },
  ])
  const now = fake.state.clock

  const first = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), { now })
  assert.equal(first.insightId, 'ins-1')
  assert.equal(first.deliveries.length, 2, 'both linked users, not the revoked one')
  assert.deepEqual(
    first.deliveries.map((d) => d.mode),
    ['posted', 'posted'],
  )
  assert.equal(fake.messages.length, 2, 'one digest per user')

  // A second, different insight moments later folds into the same two messages —
  // NOT one-message-per-event.
  const second = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-2', { brief: { insightId: 'ins-2', whatChanged: 'New tender opened', kind: 'opportunity' } }),
    { now },
  )
  assert.deepEqual(
    second.deliveries.map((d) => d.mode),
    ['coalesced', 'coalesced'],
  )
  assert.equal(fake.messages.length, 2, 'still one digest per user after two events')

  const msg = fake.messages[0]!
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content, 'You have 2 new signals from DeepSignal')
  assert.deepEqual(
    digestInsights(msg).map((i) => i.insightId),
    ['ins-1', 'ins-2'],
  )
  const cards = msg.metadata.uiCards as Array<{ kind: string; productSlug: string; fields?: Array<{ label: string }> }>
  assert.equal(cards[0]?.kind, 'integration')
  assert.equal(cards[0]?.productSlug, 'deepsignal')
  assert.ok(cards[0]?.fields?.some((f) => f.label === 'Risks'))
  assert.ok(cards[0]?.fields?.some((f) => f.label === 'Opportunities'))
})

test('insight fan-out is idempotent per insight (no double count)', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
  ])
  const now = fake.state.clock

  await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), { now })
  const repeat = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), { now })

  assert.deepEqual(
    repeat.deliveries.map((d) => d.mode),
    ['duplicate'],
    'same insight is recognised, not re-counted',
  )
  assert.equal(fake.messages.length, 1)
  assert.equal(digestInsights(fake.messages[0]!).length, 1, 'insight counted once')
})

test('over-budget insights are suppressed from the channel but still recorded', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
  ])
  // budgetMax=1 + coalesceWindow=0: the first insight posts a fresh digest; the
  // next (outside the coalesce window, budget exhausted) must NOT post a second
  // message — it folds into the existing digest instead.
  const opts = { budgetMax: 1, coalesceWindowMs: 0, budgetWindowMs: 24 * 60 * 60 * 1000 }

  fake.state.clock = new Date('2026-07-12T00:00:00.000Z')
  const first = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), {
    ...opts,
    now: fake.state.clock,
  })
  assert.deepEqual(first.deliveries.map((d) => d.mode), ['posted'])
  assert.equal(fake.messages.length, 1)

  fake.state.clock = new Date('2026-07-12T02:00:00.000Z')
  const second = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-2', { brief: { insightId: 'ins-2', whatChanged: 'Second event', kind: 'opportunity' } }),
    { ...opts, now: fake.state.clock },
  )
  assert.deepEqual(second.deliveries.map((d) => d.mode), ['suppressed'], 'no fresh interruption over budget')
  assert.equal(fake.messages.length, 1, 'no second channel message')
  assert.equal(digestInsights(fake.messages[0]!).length, 2, 'insight still recorded on the digest')
})

test('insight fan-out targets only the named recipient subs when present', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
    { organizationId: ORG, userId: USER_B, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-b' },
  ])
  const result = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-2', { recipientSubs: ['sub-b'] }),
    { now: fake.state.clock },
  )
  assert.equal(result.deliveries.length, 1)
  assert.equal(result.deliveries[0]?.channelId, `chan-${USER_B}`)

  // The digest card links to the Signals inbox, not a per-insight external link.
  const cards = fake.messages[0]!.metadata.uiCards as Array<{ actions?: Array<{ label: string; href: string }> }>
  assert.equal(cards[0]?.actions?.[0]?.label, 'View signals')
  assert.equal(cards[0]?.actions?.[0]?.href, '/signals')
})

test('dedupe is unbounded: a replay past the budget window is still a no-op', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
  ])
  // A 1h budget window: the replay arrives 2h later, outside the windowed scan.
  const opts = { budgetWindowMs: 60 * 60 * 1000, coalesceWindowMs: 0, budgetMax: 6 }

  fake.state.clock = new Date('2026-07-12T00:00:00.000Z')
  const first = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), {
    ...opts,
    now: fake.state.clock,
  })
  assert.deepEqual(first.deliveries.map((d) => d.mode), ['posted'])

  // Same insight replayed after the budget window elapses (signed body carries no
  // nonce/timestamp). The old windowed scan would miss it and re-record + re-ping;
  // the unbounded containment check recognises it as a duplicate.
  fake.state.clock = new Date('2026-07-12T02:00:00.000Z')
  const replay = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), {
    ...opts,
    now: fake.state.clock,
  })
  assert.deepEqual(replay.deliveries.map((d) => d.mode), ['duplicate'], 'replay is not re-recorded')
  assert.equal(fake.messages.length, 1, 'no second digest from the replay')
  assert.equal(messageInsightIds(fake.messages[0]!).length, 1, 'insight counted once')
})

test('soft-deleted digests are ignored: a fresh digest is posted, not resurrected', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
  ])
  const now = new Date('2026-07-12T00:00:00.000Z')
  fake.state.clock = now

  const first = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), { now })
  assert.deepEqual(first.deliveries.map((d) => d.mode), ['posted'])

  // The user deletes the digest: content is blanked and `deletedAt` set.
  fake.messages[0]!.deletedAt = new Date()
  fake.messages[0]!.content = ''

  // A new insight must post a FRESH digest — never fold into (and un-blank) the
  // tombstoned row.
  const second = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-2', { brief: { insightId: 'ins-2', whatChanged: 'New tender', kind: 'opportunity' } }),
    { now },
  )
  assert.deepEqual(second.deliveries.map((d) => d.mode), ['posted'], 'fresh digest, not a fold')
  assert.equal(fake.messages.length, 2)
  assert.equal(fake.messages[0]!.content, '', 'deleted digest stays blanked')

  // An insight recorded only on the deleted digest is no longer a duplicate, so
  // it can be re-delivered onto the live digest.
  const redeliver = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), { now })
  assert.notEqual(redeliver.deliveries[0]?.mode, 'duplicate', 'dedupe ignores deleted digests')
  assert.equal(fake.messages[0]!.content, '', 'deleted digest still untouched')
})

test('budgetMax=0 suppresses the ping but still records the insight', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
  ])
  const now = fake.state.clock

  const result = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'), {
    now,
    budgetMax: 0,
  })
  // Not 'posted' → publishInsightDeliveries emits no realtime ping, yet the
  // insight is recorded on a (silent) digest, not dropped.
  assert.deepEqual(result.deliveries.map((d) => d.mode), ['suppressed'])
  assert.equal(fake.messages.length, 1, 'insight recorded on a silent digest')
  assert.equal(messageInsightIds(fake.messages[0]!).length, 1)
})
