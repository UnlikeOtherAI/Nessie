import assert from 'node:assert/strict'
import crypto, { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  createLedgerIdentityService,
  LedgerIdentityError,
  viewerSatisfiesBasis,
} from '@nessie/runtime'

import { dispatchNextMailboxMessage } from '../../src/control/mailbox.js'
import { runReplyBasis } from '../../src/run/execute/agent-message.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'
import {
  cleanup,
  dispatchSeededMail,
  peerIdentity,
  queueMail,
  realtime,
  seedTeam,
} from './mailbox-serialization-fixture.js'

const ledgerPrivateKey = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
}).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const delegationToken = (tokenVersion = 7) =>
  `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_300, tv: tokenVersion })).toString('base64url')}.signature`

const ledgerService = (input: {
  link: { status: string; uoaSub: string | null; uoaTokenVersion: number | null } | null
  onExchange?: () => void
  onLinkLookup?: (where: {
    organizationId_userId_productSlug: {
      organizationId: string
      productSlug: string
      userId: string
    }
  }) => void
  onTeamLookup?: (where: { id: string }) => void
}) => createLedgerIdentityService({
  prisma: {
    productAccountLink: {
      findUnique: async ({ where }: { where: {
        organizationId_userId_productSlug: {
          organizationId: string
          productSlug: string
          userId: string
        }
      } }) => {
        input.onLinkLookup?.(where)
        return input.link
      },
    },
    team: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        input.onTeamLookup?.(where)
        return { externalOrgId: 'uoa-org', externalTeamId: 'uoa-team' }
      },
    },
  } as never,
  settings: {
    authBaseUrl: 'https://authentication.unlikeotherai.com',
    clientSecret: 'test-client-secret',
    configUrl: 'https://api.nessie.works/api/auth/sso/config',
    kid: 'mailbox-test',
    ledgerAudience: 'https://ledger.unlikeotherai.com',
    privateKeyPem: ledgerPrivateKey,
    sourceDomain: 'api.nessie.works',
  },
  fetchImpl: (async () => {
    input.onExchange?.()
    return new Response(JSON.stringify({ access_token: delegationToken(), expires_in: 300 }))
  }) as typeof fetch,
})

runDatabaseTest('peer delivery keeps a restricted research basis through the coordinator reply ACL', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const sourceBasis = [{ scopeId: seed.requesterId, scopeType: 'user' }]
  const disclosureSources = [
    { sourceAuthorUserId: seed.requesterId, sourceChannelId: seed.channelId },
    { sourceAuthorUserId: null, sourceChannelId: seed.channelId },
  ]
  const mail = await queueMail(
    prisma,
    seed,
    'review the prospect evidence',
    2,
    sourceBasis,
    disclosureSources,
    undefined,
    peerIdentity('requester-one'),
  )
  await dispatchSeededMail(prisma, mail)

  const rows = await prisma.$queryRaw<{ payload: { actorContext: { actionContext: { correlationId?: string; effectiveUserId?: string; purpose?: string; uoaIdentity?: unknown }; tenant: { projectId?: string; teamId?: string } }; runId: string } }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`mailbox:${mail.id}`}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.payload.actorContext.actionContext.purpose, 'agent.peer_delegation')
  assert.equal(rows[0]?.payload.actorContext.actionContext.correlationId, '2')
  assert.equal(rows[0]?.payload.actorContext.actionContext.effectiveUserId, seed.requesterId)
  assert.deepEqual(rows[0]?.payload.actorContext.actionContext.uoaIdentity, peerIdentity('requester-one'))
  assert.equal(rows[0]?.payload.actorContext.tenant.projectId, seed.projectId)
  assert.equal(rows[0]?.payload.actorContext.tenant.teamId, seed.teamId)

  // This is the real admission boundary used by inference, with the exact
  // actor context from direct peer delivery. The immutable tuple authorizes
  // only its original requester and remains live-link checked on every call.
  const actorContext = rows[0]?.payload.actorContext
  assert.ok(actorContext)
  const queuedRunId = rows[0]?.payload.runId
  assert.ok(queuedRunId)
  const attribution = attributionFromActorContext(actorContext as never, { runId: queuedRunId })
  let exchanges = 0
  let linkedUserId: string | undefined
  let linkedTeamId: string | undefined
  const valid = ledgerService({
    link: { status: 'linked', uoaSub: 'requester-one', uoaTokenVersion: 7 },
    onExchange: () => { exchanges += 1 },
    onLinkLookup: (where) => { linkedUserId = where.organizationId_userId_productSlug.userId },
    onTeamLookup: (where) => { linkedTeamId = where.id },
  })
  const headers = await valid.requestHeaders(attribution, { requireUoaIdentity: true })
  assert.ok(headers['X-UOA-Delegation'])
  assert.equal(exchanges, 1)
  assert.equal(linkedUserId, seed.requesterId)
  assert.equal(linkedTeamId, seed.teamId)
  const missingCapturedIdentity = { ...attribution }
  delete missingCapturedIdentity.uoaIdentity
  await assert.rejects(
    valid.requestHeaders(missingCapturedIdentity, { requireUoaIdentity: true }),
    (error: unknown) => error instanceof LedgerIdentityError
      && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED',
    'a peer job without the captured tuple must not borrow a mutable account identity',
  )
  for (const link of [
    null,
    { status: 'linked', uoaSub: 'requester-one', uoaTokenVersion: 8 },
    { status: 'revoked', uoaSub: 'requester-one', uoaTokenVersion: 7 },
  ]) {
    const rejected = ledgerService({ link })
    await assert.rejects(
      rejected.requestHeaders(attribution, { requireUoaIdentity: true }),
      (error: unknown) => error instanceof LedgerIdentityError
        && error.code === 'LEDGER_UOA_IDENTITY_REQUIRED',
    )
  }

  const prompt = await prisma.message.findFirstOrThrow({
    where: { content: 'review the prospect evidence', threadId: seed.threadId },
    select: {
      basisScopes: { select: { scopeId: true, scopeType: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
      role: true,
    },
  })
  assert.equal(prompt.role, 'system')
  assert.deepEqual(prompt.basisScopes, sourceBasis)
  assert.deepEqual(prompt.disclosureSources, disclosureSources)

  const run = await prisma.run.findFirstOrThrow({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
    select: { basisScopes: { select: { scopeId: true, scopeType: true } }, replyPlacement: true },
  })
  assert.deepEqual(run.basisScopes, sourceBasis)
  assert.equal(run.replyPlacement, 'channel')

  // run-job admits the stamped prompt basis into this sink before the model
  // starts. The ordinary project channel does not imply a person-only source,
  // so every coordinator reply retains that source ACL at read time.
  const consumedSources = createConsumedSourceSink()
  consumedSources.addAll(prompt.basisScopes)
  const outputBasis = runReplyBasis({
    boundAgentIds: [],
    channel: {
      id: seed.channelId,
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      systemChannelType: null,
      teamId: seed.teamId,
    },
    consumedSources,
  } as RunContext)
  assert.deepEqual(outputBasis, sourceBasis)
  assert.equal(viewerSatisfiesBasis(outputBasis, {
    kind: 'user', scopes: sourceBasis, userId: seed.requesterId,
  }), true)
  assert.equal(viewerSatisfiesBasis(outputBasis, {
    kind: 'user', scopes: [], userId: randomUUID(),
  }), false)

  // The delivery row is terminal; replaying the sweep cannot create a second run.
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), false)
  assert.equal(await prisma.run.count({ where: { agentId: seed.toAgentId, threadId: seed.threadId } }), 1)
})
