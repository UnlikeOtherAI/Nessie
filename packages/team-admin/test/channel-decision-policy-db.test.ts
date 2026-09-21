import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import { DEFAULT_CHANNEL_DECISION_POLICY, type ChannelDecisionPolicy } from '@nessie/schemas'
import { updateChannel } from '../src/channel-manage.js'
import { ChannelDecisionPolicyError } from '../src/channel-decision-policy.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip

databaseTest('channel decision policies keep channel authority, exact bindings, and one durable audit', async (t) => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userIds = [randomUUID(), randomUUID(), randomUUID()]
  const [memberId, outsiderId, adminId] = userIds as [string, string, string]
  const agentId = randomUUID()
  t.after(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })
  await prisma.organization.create({ data: { id: organizationId, name: 'Channel decisions test' } })
  await prisma.user.createMany({ data: userIds.map((id) => ({
    id, displayName: 'Policy tester', email: `channel-decisions-${id}@example.test`,
  })) })
  await prisma.organizationMember.createMany({ data: userIds.map((userId) => ({
    organizationId, userId, role: userId === adminId ? 'admin' : 'member',
  })) })
  const project = await prisma.project.create({ data: { organizationId, name: 'Policy test' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Policy test' } })
  const channel = await prisma.channel.create({ data: {
    organizationId, projectId: project.id, teamId: team.id,
    label: 'Decisions', visibility: 'protected', members: { create: { userId: memberId } },
  } })
  await prisma.agent.create({ data: { id: agentId, organizationId, teamId: team.id, name: 'Decision recorder' } })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  const policy: ChannelDecisionPolicy = {
    ...DEFAULT_CHANNEL_DECISION_POLICY,
    enabled: true,
    questions: [{ id: 'record', instructions: 'Má se rozhodnutí zapsat?', options: [
      { id: 'skip', description: 'Nothing settled yet.' },
      { id: 'discuss', description: 'Needs a human decision.' },
      { id: 'record', description: 'Record the decision.', followUp: {
        agentId, instructions: 'Update the project decision log.',
      } },
    ] }],
  }
  const input = { organizationId, channelId: channel.id, userId: memberId }

  await t.test('an ordinary channel member saves and reads a multi-option policy', async () => {
    const updated = await updateChannel(prisma, { ...input, decisionPolicy: policy })
    assert.deepEqual(updated?.decisionPolicy, policy)
    const audits = await prisma.auditLog.findMany({ where: {
      organizationId, resourceId: channel.id, action: 'channel.updated',
    } })
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.actorId, memberId)
    assert.deepEqual(audits[0]?.metadata, { changed: ['decisionPolicy'] })
    assert.ok(audits[0]?.entryHash)
  })

  await t.test('an outsider cannot edit; an org admin can manage without joining', async () => {
    assert.equal(await updateChannel(prisma, { ...input, userId: outsiderId, decisionPolicy: null }), null)
    const updated = await updateChannel(prisma, { ...input, userId: adminId, decisionPolicy: null })
    assert.equal(updated?.decisionPolicy, null)
    assert.equal(await prisma.channelMember.count({ where: { channelId: channel.id, userId: adminId } }), 0)
  })

  await t.test('removing a target binding refuses a policy and its accompanying edits', async () => {
    await prisma.agentBinding.deleteMany({ where: { channelId: channel.id, agentId } })
    await assert.rejects(updateChannel(prisma, { ...input, topic: 'Must not be saved', decisionPolicy: policy }),
      ChannelDecisionPolicyError)
    const stored = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })
    assert.equal(stored.topic, null)
    assert.equal(stored.decisionPolicy, null)
  })

  await t.test('a direct-message participant cannot add a channel policy', async () => {
    const dm = await prisma.channel.create({ data: {
      organizationId, projectId: project.id, teamId: team.id,
      label: 'Private conversation', type: 'dm', visibility: 'private',
      dmKey: [organizationId, team.id, ...[memberId, adminId].sort()].join(':'),
      members: { create: [{ userId: memberId, role: 'owner' }, { userId: adminId }] },
    } })
    await assert.rejects(updateChannel(prisma, {
      ...input, channelId: dm.id, decisionPolicy: DEFAULT_CHANNEL_DECISION_POLICY,
    }), /only for standard channels/)
  })
})
