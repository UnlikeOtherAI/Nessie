import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
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

// ─── Insight fan-out + idempotency ──────────────────────────────────────────

type Link = { organizationId: string; userId: string; productSlug: string; status: string; uoaSub: string | null }
type StoredMessage = { threadId: string; role: string; agentId: string | null; metadata: Record<string, unknown> }

const USER_A = '00000000-0000-4000-8000-0000000000b1'
const USER_B = '00000000-0000-4000-8000-0000000000b2'

const makeInsightFake = (links: Link[]) => {
  const messages: StoredMessage[] = []
  const channels = new Map<string, { id: string; archivedAt: Date | null }>()
  for (const link of links) {
    channels.set(`extagent:deepsignal:${link.organizationId}:${link.userId}`, {
      id: `chan-${link.userId}`,
      archivedAt: null,
    })
  }
  return {
    messages,
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
    message: {
      findFirst: async (args: { where: { threadId: string; metadata: { equals: string } } }) =>
        messages.find(
          (m) =>
            m.threadId === args.where.threadId &&
            (m.metadata.external as { insightId?: string })?.insightId === args.where.metadata.equals,
        ) ?? null,
      create: async (args: { data: StoredMessage }) => {
        messages.push(args.data)
        return { id: `msg-${messages.length}` }
      },
    },
  }
}

const asPrisma = (fake: ReturnType<typeof makeInsightFake>): PrismaClient => fake as unknown as PrismaClient

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
    band: 'high',
  },
  ...extra,
})

test('insight fan-out posts one message per linked user and is idempotent per insight', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
    { organizationId: ORG, userId: USER_B, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-b' },
    { organizationId: ORG, userId: 'x', productSlug: 'deepsignal', status: 'revoked', uoaSub: 'sub-x' },
  ])

  const first = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'))
  assert.equal(first.insightId, 'ins-1')
  assert.equal(first.deliveries.length, 2, 'both linked users, not the revoked one')
  assert.equal(fake.messages.length, 2)

  // The card is well-formed and carries the insight key for idempotency.
  const msg = fake.messages[0]!
  assert.equal(msg.role, 'assistant')
  assert.equal((msg.metadata.external as { insightId: string }).insightId, 'ins-1')
  const cards = msg.metadata.uiCards as Array<{ kind: string; productSlug: string; status: string }>
  assert.equal(cards[0]?.kind, 'integration')
  assert.equal(cards[0]?.productSlug, 'deepsignal')

  const second = await handleDeepSignalInsightSurfaced(asPrisma(fake), ORG, insightPayload('ins-1'))
  assert.equal(second.deliveries.length, 0, 'same insight is not re-posted')
  assert.equal(fake.messages.length, 2)
})

test('insight fan-out targets only the named recipient subs when present', async () => {
  const fake = makeInsightFake([
    { organizationId: ORG, userId: USER_A, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-a' },
    { organizationId: ORG, userId: USER_B, productSlug: 'deepsignal', status: 'linked', uoaSub: 'sub-b' },
  ])
  const result = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-2', { recipientSubs: ['sub-b'], url: 'https://deepsignal.live/i/ins-2' }),
  )
  assert.equal(result.deliveries.length, 1)
  assert.equal(result.deliveries[0]?.channelId, `chan-${USER_B}`)

  // The payload URL becomes an "Open in DeepSignal" action.
  const cards = fake.messages[0]!.metadata.uiCards as Array<{ actions?: Array<{ label: string; href: string }> }>
  assert.equal(cards[0]?.actions?.[0]?.label, 'Open in DeepSignal')
  assert.equal(cards[0]?.actions?.[0]?.href, 'https://deepsignal.live/i/ins-2')
})
