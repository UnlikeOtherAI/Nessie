import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  getAttentionSummary,
  listUserAlerts,
  markUserAlertsRead,
} from '../src/services/alerts.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  alertId: string
  channelAId: string
  channelBId: string
  installationId: string
  organizationId: string
  userId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `workflow alert ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `workflow alert project ${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `workflow alert team ${suffix}`, projectId: project.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Workflow reader', email: `workflow-alert-${suffix}@example.com` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: user.id },
  })
  const channelA = await prisma.channel.create({
    data: {
      label: 'Workflow channel A',
      organizationId: organization.id,
      projectId: project.id,
      slug: `workflow-alert-a-${suffix}`,
      teamId: team.id,
      visibility: 'protected',
    },
  })
  const channelB = await prisma.channel.create({
    data: {
      label: 'Workflow channel B',
      organizationId: organization.id,
      projectId: project.id,
      slug: `workflow-alert-b-${suffix}`,
      teamId: team.id,
      visibility: 'protected',
    },
  })
  await prisma.channelMember.create({ data: { channelId: channelA.id, userId: user.id } })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: { steps: [] },
      name: `Workflow alert ${suffix}`,
      organizationId: organization.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      channelId: channelA.id,
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: organization.id,
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const run = await prisma.workflowRun.create({
    data: {
      errorMessage: 'The workflow failed.',
      finishedAt: new Date(),
      installationId: installation.id,
      organizationId: organization.id,
      startedAt: new Date(),
      startedByActorId: user.id,
      startedByActorType: 'user',
      status: 'failed',
    },
  })
  const alert = await prisma.userAlert.create({
    data: {
      // This is deliberately the original channel. Authorization must ignore
      // it once the installation's current channel changes.
      channelId: channelA.id,
      eventKey: `workflow-run-failure:${run.id}`,
      kind: 'workflow_run_failed',
      organizationId: organization.id,
      userId: user.id,
      workflowRunId: run.id,
    },
  })

  return {
    alertId: alert.id,
    channelAId: channelA.id,
    channelBId: channelB.id,
    installationId: installation.id,
    organizationId: organization.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, fixture: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: fixture.organizationId } })
  await prisma.user.deleteMany({ where: { id: fixture.userId } })
}

const assertAlertAccess = async (
  prisma: PrismaClient,
  fixture: Seed,
  visible: boolean,
): Promise<void> => {
  const input = { organizationId: fixture.organizationId, userId: fixture.userId }
  const expectedIds = visible ? [fixture.alertId] : []
  const listed = await listUserAlerts(prisma, input)
  assert.deepEqual(listed.data.map((alert) => alert.id), expectedIds, 'the list follows current scope')
  assert.equal(listed.meta.total, expectedIds.length, 'the list total follows current scope')

  const summary = await getAttentionSummary(prisma, input)
  assert.equal(summary.unreadCount, expectedIds.length, 'the unread count follows current scope')

  const marked = await markUserAlertsRead(prisma, { ids: [fixture.alertId], ...input })
  assert.equal(marked.read, expectedIds.length, 'read only changes an alert that remains visible')
  assert.equal(marked.unreadCount, 0, 'the count is recomputed through the same predicate')

  const persisted = await prisma.userAlert.findUnique({ where: { id: fixture.alertId } })
  assert.equal(Boolean(persisted?.readAt), visible, 'the protected row is never marked stale')
  if (visible) {
    await prisma.userAlert.update({ where: { id: fixture.alertId }, data: { readAt: null } })
  }
}

runDatabaseTest('workflow failure alerts follow the installation channel after retarget and revocation', async (t) => {
  const prisma = new PrismaClient()
  const fixture = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, fixture)
    await prisma.$disconnect()
  })

  await assertAlertAccess(prisma, fixture, true)

  // The reader may still see historical A, but the installation now points to
  // private B. The old alert channel must not keep the run visible.
  await prisma.workflowInstallation.update({
    where: { id: fixture.installationId },
    data: { channelId: fixture.channelBId },
  })
  await assertAlertAccess(prisma, fixture, false)

  await prisma.channelMember.create({ data: { channelId: fixture.channelBId, userId: fixture.userId } })
  await prisma.channelMember.delete({
    where: { channelId_userId: { channelId: fixture.channelAId, userId: fixture.userId } },
  })
  await assertAlertAccess(prisma, fixture, true)

  // Reverse the retarget: B membership cannot authorize a run currently in
  // private A, even though the alert happened to be written against A.
  await prisma.workflowInstallation.update({
    where: { id: fixture.installationId },
    data: { channelId: fixture.channelAId },
  })
  await assertAlertAccess(prisma, fixture, false)

  await prisma.channelMember.create({ data: { channelId: fixture.channelAId, userId: fixture.userId } })
  await prisma.channelMember.delete({
    where: { channelId_userId: { channelId: fixture.channelBId, userId: fixture.userId } },
  })
  await assertAlertAccess(prisma, fixture, true)

  await prisma.channelMember.delete({
    where: { channelId_userId: { channelId: fixture.channelAId, userId: fixture.userId } },
  })
  await assertAlertAccess(prisma, fixture, false)
})
