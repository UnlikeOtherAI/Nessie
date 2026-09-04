import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
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
