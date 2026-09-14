import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'

import { dispatchNextMailboxMessage } from '../../src/control/mailbox.js'
import { deleteThreadQueueJobs } from './support.js'

export type Seed = {
  organizationId: string
  projectId: string
  requesterId: string
  secondRequesterId: string
  teamId: string
  channelId: string
  threadId: string
  fromAgentId: string
  toAgentId: string
}

export const peerIdentity = (subject: string) => ({
  organizationId: 'uoa-org', subject, teamId: 'uoa-team', tokenVersion: 7,
})

export const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mbx-ser ${randomUUID()}` } })
  const requester = await prisma.user.create({ data: { displayName: 'Requester', email: `mbx-${randomUUID()}@example.test` } })
  const secondRequester = await prisma.user.create({ data: { displayName: 'Second requester', email: `mbx-${randomUUID()}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId: org.id, role: 'owner', userId: requester.id } })
  await prisma.organizationMember.create({ data: { organizationId: org.id, role: 'member', userId: secondRequester.id } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
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
  const fromAgent = await prisma.agent.create({
    data: { name: 'From', organizationId: org.id },
  })
  const toAgent = await prisma.agent.create({ data: { name: 'To', organizationId: org.id } })
  await prisma.agentBinding.create({
    data: { agentId: toAgent.id, channelId: channel.id },
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    requesterId: requester.id,
    secondRequesterId: secondRequester.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    fromAgentId: fromAgent.id,
    toAgentId: toAgent.id,
  }
}

export const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await deleteThreadQueueJobs(prisma, seed.threadId)
  await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentMailboxMessage.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentBinding.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: { in: [seed.fromAgentId, seed.toAgentId] } } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
  await prisma.user.deleteMany({ where: { id: { in: [seed.requesterId, seed.secondRequesterId] } } })
}

export const realtime = {
  publishSse: async () => undefined,
  publishWs: async () => undefined,
} as unknown as PgRealtimeTransport

// `visibleAt` is set explicitly in the past instead of defaulting to
// `CURRENT_TIMESTAMP`. The column is `timestamp(3)`, and Postgres ROUNDS to
// that precision on storage while the poller's `visible_at <= now()` predicate
// compares against full-microsecond `now()` — so a row written at x.9995ms is
// stored as (x+1).000ms and is briefly due in the future. The real poller loops
// and picks it up microseconds later; a test that dispatches exactly once would
// just be flaky (~1 in 10). What these tests are about is the (agent, thread)
// claim, not visibility timing, so the seeded mail is unambiguously due.
export const queueMail = async (
  prisma: PrismaClient,
  seed: Seed,
  body: string,
  peerDelegationDepth?: number,
  basis: { scopeId: string; scopeType: string }[] = [],
  disclosureSources: { sourceAuthorUserId: string | null; sourceChannelId: string }[] = [],
  actorId?: string,
  uoaIdentity?: unknown,
): Promise<{ id: string }> => {
  return prisma.agentMailboxMessage.create({
    data: {
      organizationId: seed.organizationId,
      fromAgentId: seed.fromAgentId,
      toAgentId: seed.toAgentId,
      channelId: seed.channelId,
      threadId: seed.threadId,
      actorId: peerDelegationDepth === undefined ? seed.fromAgentId : (actorId ?? seed.requesterId),
      actorType: peerDelegationDepth === undefined ? 'agent' : 'user',
      basis,
      disclosureSources,
      body,
      correlationId: randomUUID(),
      peerDelegationDepth,
      ...(uoaIdentity ? { uoaIdentity } : {}),
      visibleAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  })
}

// Dispatch and prove the seeded mail is the row that was claimed. The poller
// picks the globally oldest queued message, so a foreign row appearing between
// the preflight and here would otherwise surface as a confusing "0 pending
// markers" further down instead of naming the real cause.
export const dispatchSeededMail = async (
  prisma: PrismaClient,
  mail: { id: string },
): Promise<void> => {
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), true)
  const dispatched = await prisma.agentMailboxMessage.findUnique({
    where: { id: mail.id },
    select: { status: true },
  })
  assert.equal(
    dispatched?.status,
    'delivered',
    'the poller claimed a different mailbox row — the database is not exclusive to this suite',
  )
}

