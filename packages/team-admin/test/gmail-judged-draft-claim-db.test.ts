import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { sealSecret } from '@nessie/comms-connect'

import {
  GmailDraftError,
  fingerprintDraft,
  hasLiveJudgedGmailDraftAuthorization,
  mintJudgedGmailDraftAuthorization,
  revokeSendAuthorization,
  sendDraftForUser,
} from '../src/index.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip
const encryptionSecret = 'judged-gmail-claim-test-secret'
const scope = 'https://www.googleapis.com/auth/gmail.compose'

const liveDraft = {
  id: 'provider-draft',
  message: {
    id: 'provider-message',
    payload: {
      body: { data: Buffer.from('A routine reply.', 'utf8').toString('base64url') },
      headers: [
        { name: 'To', value: 'recipient@example.test' },
        { name: 'Subject', value: 'Routine update' },
      ],
      mimeType: 'text/plain',
    },
    threadId: 'provider-thread',
  },
}

type Seed = {
  agentId: string
  connectionId: string
  draftId: string
  fingerprint: string
  grantId: string
  organizationId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const user = await prisma.user.create({
    data: { displayName: 'Owner', email: `judged-gmail-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `judged-gmail-${suffix}` } })
  const agent = await prisma.agent.create({
    data: { name: 'Sender', organizationId: organization.id },
  })
  const connection = await prisma.commsConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: user.id,
      provider: 'google',
      externalTenantId: `tenant-${suffix}`,
      externalUserId: `owner-${suffix}@example.test`,
      grantedScopes: [scope],
    },
  })
  await prisma.commsConnectionCredential.create({
    data: {
      accessTokenCiphertext: sealSecret(encryptionSecret, 'access-token'),
      connectionId: connection.id,
      expiresAt: new Date('2999-01-01T00:00:00.000Z'),
      scopeHash: 'test-scope-hash',
    },
  })
  const fingerprint = fingerprintDraft({
    body: 'A routine reply.',
    subject: 'Routine update',
    to: ['recipient@example.test'],
  })
  const draft = await prisma.gmailDraftAction.create({
    data: {
      connectionId: connection.id,
      contentFingerprint: fingerprint,
      organizationId: organization.id,
      ownerUserId: user.id,
      providerDraftId: 'provider-draft',
    },
  })
  const grant = await prisma.sendAuthorizationGrant.create({
    data: {
      agentId: agent.id,
      boundary: 'Send routine updates.',
      connectionId: connection.id,
      grantedByUserId: user.id,
      mode: 'judged',
      organizationId: organization.id,
    },
  })
  return {
    agentId: agent.id,
    connectionId: connection.id,
    draftId: draft.id,
    fingerprint,
    grantId: grant.id,
    organizationId: organization.id,
    userId: user.id,
  }
}

runDatabaseTest('a revoke between the prior live check and judged draft claim prevents Gmail dispatch', async (t) => {
  const prisma = new PrismaClient()
  const input = await seed(prisma)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: input.organizationId } })
    await prisma.user.delete({ where: { id: input.userId } })
    await prisma.$disconnect()
  })

  const authorization = mintJudgedGmailDraftAuthorization({
    agentId: input.agentId,
    boundary: 'Send routine updates.',
    connectionId: input.connectionId,
    contentFingerprint: input.fingerprint,
    draftActionId: input.draftId,
    grantId: input.grantId,
    organizationId: input.organizationId,
    requestingUserId: input.userId,
  })
  assert.equal(await hasLiveJudgedGmailDraftAuthorization(prisma, authorization), true)

  let sent = 0
  let revoked = false
  await assert.rejects(
    sendDraftForUser(
      prisma,
      {
        draftActionId: input.draftId,
        expectedFingerprint: input.fingerprint,
        judgedAuthorization: authorization,
        organizationId: input.organizationId,
        userId: input.userId,
      },
      {
        encryptionSecret,
        fetchImpl: (async (url: string) => {
          if (url.includes('/drafts/send')) {
            sent += 1
            return { json: async () => ({ id: 'sent' }), ok: true, status: 200, text: async () => '{}' }
          }
          if (!revoked) {
            revoked = true
            assert.equal(await revokeSendAuthorization(prisma, {
              grantId: input.grantId,
              organizationId: input.organizationId,
              userId: input.userId,
            }), true)
          }
          return { json: async () => liveDraft, ok: true, status: 200, text: async () => '{}' }
        }) as never,
      },
    ),
    (error: unknown) => error instanceof GmailDraftError
      && error.code === 'JUDGED_AUTHORIZATION_INVALID',
  )
  assert.equal(sent, 0, 'a revoked judged grant must never reach Gmail')
  assert.equal(
    (await prisma.gmailDraftAction.findUniqueOrThrow({ where: { id: input.draftId } })).state,
    'draft',
  )
})
