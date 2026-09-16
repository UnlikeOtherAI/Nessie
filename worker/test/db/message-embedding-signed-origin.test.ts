import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { claimMessageEmbeddingInTransaction } from '@nessie/db'
import {
  EMBEDDING_DIMENSIONS,
  MessageEmbedJobPayloadSchema,
  type MessageEmbedJobPayload,
} from '@nessie/schemas'

import { executeMessageEmbedJob } from '../../src/control/message-embed.js'
import { runDatabaseTest } from './support.js'

// Spelled out rather than imported, so this test also fails on its assertions —
// not on a missing export — against a build without the skip.
const MESSAGE_EMBED_IDENTITY_UNAVAILABLE = 'uoa_identity_unavailable'

// A signing deployment refuses every Ledger call whose attribution lacks the
// originating session's UOA identity, and a queue job has no session. The
// identity must therefore be captured into the job where a session existed —
// the send — and a claim made without one (the sweep) must end as a recorded
// skip, never a dead-lettered retry loop.

const MODEL = 'test-signed-message-embedding'
const UOA_IDENTITY = {
  organizationId: 'uoa-org',
  subject: 'uoa-subject',
  teamId: 'uoa-team',
  tokenVersion: 19,
}

runDatabaseTest('a signed send is indexed as its sender and an origin-less sweep claim is skipped', async () => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({ data: { name: `signed embed ${randomUUID()}` } })
  try {
    const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
    const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
    const channel = await prisma.channel.create({
      data: {
        label: 'c',
        slug: `c-${randomUUID()}`,
        organizationId: org.id,
        projectId: project.id,
        teamId: team.id,
      },
    })
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const sent = await prisma.message.create({
      data: { content: 'Is the deploy finished after the migration?', role: 'user', threadId: thread.id },
    })
    const swept = await prisma.message.create({
      data: { content: 'An older message only the sweep reaches.', role: 'user', threadId: thread.id },
    })
    const origin = { userId: randomUUID(), uoaIdentity: UOA_IDENTITY }

    const claim = (message: { content: string; id: string }, withOrigin: boolean) =>
      prisma.$transaction((tx) => claimMessageEmbeddingInTransaction(tx, {
        content: message.content,
        embeddingModel: MODEL,
        id: message.id,
        organizationId: org.id,
        ...(withOrigin ? { origin } : {}),
      }))

    assert.equal(await claim(sent, true), true)
    assert.equal(await claim(swept, false), true)
    // The sweep reaching an already-claimed send is a no-op: the send's
    // identity-bearing job stays the only one for that source hash.
    assert.equal(await claim(sent, false), false)

    const jobs = await prisma.$queryRaw<Array<{ payload: MessageEmbedJobPayload }>>`
      SELECT payload FROM queue_jobs
      WHERE topic = 'message.embed' AND payload->>'organizationId' = ${org.id}
    `
    assert.equal(jobs.length, 2)
    const payloadFor = (messageId: string): MessageEmbedJobPayload =>
      MessageEmbedJobPayloadSchema.parse(jobs.find((job) => job.payload.messageId === messageId)!.payload)
    assert.deepEqual(payloadFor(sent.id).origin, origin)
    assert.equal(payloadFor(swept.id).origin, undefined)

    const usages: Array<Record<string, unknown>> = []
    const modelClient = {
      embeddingModel: MODEL,
      embedMany: async (texts: string[], options: { usage: Record<string, unknown> }) => {
        usages.push(options.usage)
        // What a signing Ledger answers for an unsigned attribution.
        if (!options.usage['uoaIdentity']) {
          throw new Error('Ledger requires a linked UnlikeOtherAI SSO identity for the originating user.')
        }
        return texts.map(() => Array<number>(EMBEDDING_DIMENSIONS).fill(0.1))
      },
    }
    const deps = { ledgerSigningConfigured: true, modelClient, prisma }

    await executeMessageEmbedJob(deps as never, payloadFor(sent.id))
    await executeMessageEmbedJob(deps as never, payloadFor(swept.id))

    const rows = await prisma.$queryRaw<Array<{ id: string; last_error: string | null; status: string }>>`
      SELECT message_id::text AS id, status, last_error FROM message_embeddings
      WHERE message_id IN (${sent.id}::uuid, ${swept.id}::uuid)
    `
    const rowFor = (id: string) => rows.find((row) => row.id === id)
    assert.deepEqual(rowFor(sent.id), { id: sent.id, last_error: null, status: 'indexed' })
    assert.deepEqual(rowFor(swept.id), {
      id: swept.id,
      last_error: MESSAGE_EMBED_IDENTITY_UNAVAILABLE,
      status: 'skipped',
    })
    assert.equal(usages.length, 1)
    assert.equal(usages[0]!['userId'], origin.userId)
    assert.deepEqual(usages[0]!['uoaIdentity'], UOA_IDENTITY)
  } finally {
    await prisma.$executeRaw`
      DELETE FROM queue_jobs WHERE topic = 'message.embed' AND payload->>'organizationId' = ${org.id}
    `
    await prisma.organization.delete({ where: { id: org.id } })
    await prisma.$disconnect()
  }
})
