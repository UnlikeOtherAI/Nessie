import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  MailboxConnectionError,
  persistMailboxReconnection,
  recordMailboxConnectionVerification,
} from '@nessie/team-admin'

import { evaluateMailboxSendGate } from '../../src/run/execute/mailbox-send-gate.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { runDatabaseTest } from './support.js'

type Seed = {
  adminId: string
  agentId: string
  connectionId: string
  creatorId: string
  organizationId: string
  projectId: string
  teamId: string
}

const seedSharedMailbox = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({ data: { name: `recovery ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { name: 'Mailbox recovery', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'Support', projectId: project.id } })
  const creator = await prisma.user.create({
    data: { displayName: 'Former installer', email: `${randomUUID()}@example.test` },
  })
  const admin = await prisma.user.create({
    data: { displayName: 'Active admin', email: `${randomUUID()}@example.test` },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'member', userId: creator.id },
      { organizationId: organization.id, role: 'admin', userId: admin.id },
    ],
  })
  const agent = await prisma.agent.create({
    data: { name: 'Support agent', organizationId: organization.id },
  })
  const connection = await prisma.mailboxConnection.create({
    data: {
      address: `${randomUUID().slice(0, 8)}@example.test`,
      createdByUserId: creator.id,
      imapHost: 'imap.old.example.test',
      imapPort: 993,
      label: 'Support inbox',
      lastVerifiedAt: new Date('2026-09-04T00:00:00.000Z'),
      organizationId: organization.id,
      smtpHost: 'smtp.old.example.test',
      smtpPort: 587,
      status: 'needs_reauthorization',
      statusReason: 'The email address or password was not accepted.',
      teamId: team.id,
      username: 'support@example.test',
    },
  })
  await prisma.mailboxConnectionAgentAccess.create({
    data: { agentId: agent.id, connectionId: connection.id, organizationId: organization.id },
  })
  await prisma.userAlert.create({
    data: {
      eventKey: `mailbox-health:${connection.id}:1`,
      kind: 'mailbox_connection_health',
      mailboxConnectionId: connection.id,
      organizationId: organization.id,
      userId: admin.id,
    },
  })
  await prisma.organizationMember.update({
    data: { deactivatedAt: new Date() },
    where: { organizationId_userId: { organizationId: organization.id, userId: creator.id } },
  })
  return {
    adminId: admin.id,
    agentId: agent.id,
    connectionId: connection.id,
    creatorId: creator.id,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
  }
}

const contextFor = (seed: Seed): RunContext => ({
  agent: { id: seed.agentId, name: 'Support agent' },
  boundAgentIds: [],
  channel: {
    id: randomUUID(),
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    systemChannelType: null,
    teamId: seed.teamId,
  },
  consumedSources: createConsumedSourceSink(),
  run: { id: randomUUID(), threadId: randomUUID() },
  task: { id: randomUUID() },
}) as RunContext

const createMailboxSendApproval = async (
  prisma: PrismaClient,
  seed: Seed,
  input: { approverUserId: string; status: 'approved' | 'pending' },
) => prisma.approvalRequest.create({
  data: {
    action: 'tool.invoke',
    agentId: seed.agentId,
    argsHash: randomUUID(),
    context: { mailboxConnectionId: seed.connectionId },
    continuationToken: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    organizationId: seed.organizationId,
    reason: 'Review the email before deciding whether to send it.',
    requesterId: seed.agentId,
    requiredApproverUserId: input.approverUserId,
    resumeState: {
      args: {
        connectionId: seed.connectionId,
        subject: 'Private proposal',
        text: 'Private body',
        to: ['recipient@example.test'],
      },
    },
    status: input.status,
    toolCallId: randomUUID(),
    toolName: 'mailbox_send',
  },
})

runDatabaseTest('shared reconnect transfers the live approval pin without replacing the mailbox or access rows', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedSharedMailbox(prisma)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const repaired = await persistMailboxReconnection(prisma, {
    actorUserId: seed.adminId,
    connectionId: seed.connectionId,
    imapHost: 'imap.new.example.test',
    imapPort: 993,
    imapSecurity: 'tls',
    secretCiphertext: 'replacement-secret-ciphertext',
    smtpHost: 'smtp.new.example.test',
    smtpPort: 465,
    smtpSecurity: 'tls',
    username: 'support@example.test',
  })

  assert.equal(repaired.id, seed.connectionId)
  assert.deepEqual(repaired.agentIds, [seed.agentId])
  const stored = await prisma.mailboxConnection.findUniqueOrThrow({
    include: { agentAccess: true, credential: true },
    where: { id: seed.connectionId },
  })
  assert.equal(stored.createdByUserId, seed.adminId)
  assert.equal(stored.ownerUserId, null)
  assert.equal(stored.teamId, seed.teamId)
  assert.equal(stored.status, 'active')
  assert.equal(stored.agentAccess.length, 1)
  assert.equal(stored.agentAccess[0]?.agentId, seed.agentId)
  assert.equal(stored.credential?.secretCiphertext, 'replacement-secret-ciphertext')
  assert.equal(
    await prisma.userAlert.count({ where: { mailboxConnectionId: seed.connectionId, readAt: null } }),
    0,
  )

  const decision = await evaluateMailboxSendGate(
    prisma,
    contextFor(seed),
    { connectionId: seed.connectionId, effectiveUserId: null },
  )
  assert.equal(decision.outcome, 'approval')
  if (decision.outcome === 'approval') {
    assert.equal(decision.requiredApproverUserId, seed.adminId)
  }
})

runDatabaseTest('a saved-credential check cannot reactivate a stopped mailbox or resolve its health alert', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedSharedMailbox(prisma)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  assert.equal(await recordMailboxConnectionVerification(prisma, seed.connectionId), false)
  const stopped = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: seed.connectionId } })
  assert.equal(stopped.status, 'needs_reauthorization')
  assert.equal(stopped.lastVerifiedAt?.toISOString(), '2026-09-04T00:00:00.000Z')
  assert.equal(
    await prisma.userAlert.count({ where: { mailboxConnectionId: seed.connectionId, readAt: null } }),
    1,
  )
})

runDatabaseTest('shared approver transfer rejects every pending or unconsumed approved mailbox send', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedSharedMailbox(prisma)
  t.after(async () => {
    await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  const pending = await createMailboxSendApproval(prisma, seed, {
    approverUserId: seed.creatorId,
    status: 'pending',
  })
  const approved = await createMailboxSendApproval(prisma, seed, {
    approverUserId: seed.creatorId,
    status: 'approved',
  })

  await persistMailboxReconnection(prisma, {
    actorUserId: seed.adminId,
    connectionId: seed.connectionId,
    imapHost: 'imap.new.example.test',
    imapPort: 993,
    imapSecurity: 'tls',
    secretCiphertext: 'replacement-secret-ciphertext',
    smtpHost: 'smtp.new.example.test',
    smtpPort: 465,
    smtpSecurity: 'tls',
    username: 'support@example.test',
  })

  const stale = await prisma.approvalRequest.findMany({
    orderBy: { id: 'asc' },
    where: { id: { in: [pending.id, approved.id] } },
  })
  assert.equal(stale.length, 2)
  for (const approval of stale) {
    assert.equal(approval.status, 'rejected')
    assert.ok(approval.proofConsumedAt)
    assert.equal(approval.requiredApproverUserId, seed.creatorId)
  }

  const nextDecision = await evaluateMailboxSendGate(
    prisma,
    contextFor(seed),
    { connectionId: seed.connectionId, effectiveUserId: null },
  )
  assert.deepEqual(nextDecision, {
    outcome: 'approval',
    reason: 'This would go out from a shared team mailbox.',
    requiredApproverUserId: seed.adminId,
  })
})

for (const [label, mutate] of [
  ['demoted', async (prisma: PrismaClient, seed: Seed) => prisma.organizationMember.update({
    data: { role: 'member' },
    where: { organizationId_userId: { organizationId: seed.organizationId, userId: seed.adminId } },
  })],
  ['deactivated', async (prisma: PrismaClient, seed: Seed) => prisma.organizationMember.update({
    data: { deactivatedAt: new Date() },
    where: { organizationId_userId: { organizationId: seed.organizationId, userId: seed.adminId } },
  })],
  ['removed', async (prisma: PrismaClient, seed: Seed) => prisma.organizationMember.delete({
    where: { organizationId_userId: { organizationId: seed.organizationId, userId: seed.adminId } },
  })],
] as const) {
  runDatabaseTest(`reconnect refuses a ${label} shared-mailbox manager after the slow provider test`, async (t) => {
    const prisma = new PrismaClient()
    const seed = await seedSharedMailbox(prisma)
    t.after(async () => {
      await prisma.organization.delete({ where: { id: seed.organizationId } }).catch(() => undefined)
      await prisma.$disconnect()
    })
    await mutate(prisma, seed)

    await assert.rejects(
      persistMailboxReconnection(prisma, {
        actorUserId: seed.adminId,
        connectionId: seed.connectionId,
        imapHost: 'imap.new.example.test',
        imapPort: 993,
        imapSecurity: 'tls',
        secretCiphertext: 'replacement-secret-ciphertext',
        smtpHost: 'smtp.new.example.test',
        smtpPort: 465,
        smtpSecurity: 'tls',
        username: 'support@example.test',
      }),
      (error: unknown) => error instanceof MailboxConnectionError && error.refusal === 'not_permitted',
    )
    const connection = await prisma.mailboxConnection.findUniqueOrThrow({
      include: { credential: true },
      where: { id: seed.connectionId },
    })
    assert.equal(connection.createdByUserId, seed.creatorId)
    assert.equal(connection.status, 'needs_reauthorization')
    assert.equal(connection.credential, null)
    assert.equal(
      await prisma.userAlert.count({ where: { mailboxConnectionId: seed.connectionId, readAt: null } }),
      1,
    )
  })
}
