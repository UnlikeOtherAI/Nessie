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
import {
  LOCAL_TEAM_A,
  LOCAL_TEAM_B,
  ORG,
  UOA_ORG,
  UOA_TEAM_A,
  UOA_TEAM_B,
  USER_A,
  USER_B,
  asPrisma,
  digestInsights,
  insightPayload,
  makeInsightFake,
  messageInsightIds,
  type Link,
} from './helpers/deepsignal-webhook-fake.js'

const AUTH_SECRET = 'test-auth-secret-000000000000000000'
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
  assert.equal(result.deliveries[0]?.channelId, `chan-${USER_B}-${UOA_TEAM_A}`)

  // The digest remains inside the recipient's DeepSignal conversation; it no
  // longer links out to a custom left-rail page.
  const cards = fake.messages[0]!.metadata.uiCards as Array<{ actions?: Array<{ label: string; href: string }> }>
  assert.deepEqual(cards[0]?.actions ?? [], [])
})

test('insight fan-out stays inside the exact enabled external workspace', async () => {
  const fake = makeInsightFake(
    [
      {
        activeOrgId: UOA_ORG,
        activeTeamId: UOA_TEAM_A,
        memberTeamIds: [LOCAL_TEAM_A],
        organizationId: ORG,
        userId: USER_A,
        productSlug: 'deepsignal',
        status: 'linked',
        uoaSub: 'sub-a',
      },
      {
        activeOrgId: UOA_ORG,
        activeTeamId: UOA_TEAM_B,
        memberTeamIds: [LOCAL_TEAM_B],
        organizationId: ORG,
        userId: USER_B,
        productSlug: 'deepsignal',
        status: 'linked',
        uoaSub: 'sub-b',
      },
    ],
    [
      {
        enabled: true,
        externalOrgId: UOA_ORG,
        externalTeamId: UOA_TEAM_A,
        organizationId: ORG,
        productSlug: 'deepsignal',
        teamId: LOCAL_TEAM_A,
      },
      {
        enabled: true,
        externalOrgId: UOA_ORG,
        externalTeamId: UOA_TEAM_B,
        organizationId: ORG,
        productSlug: 'deepsignal',
        teamId: LOCAL_TEAM_B,
      },
    ],
  )

  const teamA = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-team-a'),
    { now: fake.state.clock },
  )
  assert.deepEqual(
    teamA.deliveries.map((delivery) => delivery.channelId),
    [`chan-${USER_A}-${UOA_TEAM_A}`],
  )

  const teamB = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-team-b', { teamId: UOA_TEAM_B }),
    { now: fake.state.clock },
  )
  assert.deepEqual(
    teamB.deliveries.map((delivery) => delivery.channelId),
    [`chan-${USER_B}-${UOA_TEAM_B}`],
  )
})

test('insight fan-out ignores last-seen link workspace for an activated team channel', async () => {
  const fake = makeInsightFake([
    {
      activeOrgId: UOA_ORG,
      activeTeamId: UOA_TEAM_B,
      channelTeamIds: [UOA_TEAM_A],
      memberTeamIds: [LOCAL_TEAM_A],
      organizationId: ORG,
      userId: USER_A,
      productSlug: 'deepsignal',
      status: 'linked',
      uoaSub: 'sub-a',
    },
  ])

  const result = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-last-seen-other-team'),
    { now: fake.state.clock },
  )

  assert.deepEqual(
    result.deliveries.map((delivery) => delivery.channelId),
    [`chan-${USER_A}-${UOA_TEAM_A}`],
  )
})

test('insight fan-out rejects unknown, disabled, and inconsistently mapped teams', async () => {
  const link: Link = {
    activeOrgId: UOA_ORG,
    activeTeamId: UOA_TEAM_A,
    memberTeamIds: [LOCAL_TEAM_A],
    organizationId: ORG,
    userId: USER_A,
    productSlug: 'deepsignal',
    status: 'linked',
    uoaSub: 'sub-a',
  }
  const disabled = makeInsightFake([link], [
    {
      enabled: false,
      externalOrgId: UOA_ORG,
      externalTeamId: UOA_TEAM_A,
      organizationId: ORG,
      productSlug: 'deepsignal',
      teamId: LOCAL_TEAM_A,
    },
  ])
  const disabledResult = await handleDeepSignalInsightSurfaced(
    asPrisma(disabled),
    ORG,
    insightPayload('ins-disabled'),
    { now: disabled.state.clock },
  )
  assert.equal(disabledResult.deliveries.length, 0)

  const unknown = makeInsightFake([link])
  const unknownResult = await handleDeepSignalInsightSurfaced(
    asPrisma(unknown),
    ORG,
    insightPayload('ins-unknown', { teamId: 'not-an-enabled-workspace' }),
    { now: unknown.state.clock },
  )
  assert.equal(unknownResult.deliveries.length, 0)

  const inconsistent = makeInsightFake([link], [
    {
      enabled: true,
      externalOrgId: UOA_ORG,
      externalTeamId: UOA_TEAM_A,
      organizationId: ORG,
      productSlug: 'deepsignal',
      teamExternalOrgId: 'different-uoa-org',
      teamId: LOCAL_TEAM_A,
    },
  ])
  const inconsistentResult = await handleDeepSignalInsightSurfaced(
    asPrisma(inconsistent),
    ORG,
    insightPayload('ins-inconsistent'),
    { now: inconsistent.state.clock },
  )
  assert.equal(inconsistentResult.deliveries.length, 0)
})

test('insight fan-out skips links outside the exact active team membership', async () => {
  const fake = makeInsightFake([
    {
      activeOrgId: UOA_ORG,
      activeTeamId: UOA_TEAM_A,
      memberTeamIds: [LOCAL_TEAM_B],
      organizationId: ORG,
      userId: USER_A,
      productSlug: 'deepsignal',
      status: 'linked',
      uoaSub: 'sub-a',
    },
    {
      activeOrgId: UOA_ORG,
      activeTeamId: UOA_TEAM_B,
      memberTeamIds: [LOCAL_TEAM_A, LOCAL_TEAM_B],
      organizationId: ORG,
      userId: USER_B,
      productSlug: 'deepsignal',
      status: 'linked',
      uoaSub: 'sub-b',
    },
  ])

  const result = await handleDeepSignalInsightSurfaced(
    asPrisma(fake),
    ORG,
    insightPayload('ins-no-cross-team'),
    { now: fake.state.clock },
  )
  assert.equal(result.deliveries.length, 0)
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
