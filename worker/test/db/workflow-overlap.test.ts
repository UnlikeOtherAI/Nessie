import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { queueWorkflowTriggerRun } from '../../src/control/workflow-trigger-run.js'
import { runDatabaseTest } from './support.js'

// W26 — overlap policy `limit: 1, onOverlap: 'skip'`: two fires while one run
// is active produce exactly one run, and the withheld fire is recorded on its
// delivery as `skipped_overlap` so a silent skip stays diagnosable.

runDatabaseTest('W26: overlapping fires produce one run; the second delivery records skipped_overlap', async (t) => {
  const prisma = new PrismaClient()
  const org = await prisma.organization.create({
    data: { name: `wf-overlap ${randomUUID()}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Workflow Owner', email: `wf-overlap-${randomUUID()}@example.com` },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: user.id,
      createdByActorType: 'user',
      graphJson: { steps: [] },
      name: `wf ${randomUUID()}`,
      organizationId: org.id,
    },
  })
  const installation = await prisma.workflowInstallation.create({
    data: {
      concurrency: { limit: 1, onOverlap: 'skip' },
      createdByActorId: user.id,
      createdByActorType: 'user',
      organizationId: org.id,
      status: 'active',
      workflowTemplateId: template.id,
      workflowTemplateVersion: 1,
    },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      type: 'manual',
      workflowInstallationId: installation.id,
    },
  })
  t.after(async () => {
    // Scoped to the seed's own run and trigger — never a global delete.
    await prisma.$executeRaw`
      DELETE FROM queue_jobs
      WHERE topic = 'workflow.run.execute'
        AND payload->>'workflowRunId' IN (
          SELECT id::text FROM workflow_runs WHERE installation_id = ${installation.id}::uuid
        )
    `.catch(() => undefined)
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  })

  const fire = () =>
    queueWorkflowTriggerRun(prisma, {
      payload: { sweep: true },
      source: 'scheduler',
      trigger: {
        id: trigger.id,
        type: 'manual',
        workflowInstallation: {
          active: true,
          channelId: null,
          id: installation.id,
          organizationId: org.id,
          projectId: null,
          status: 'active',
          teamId: null,
        },
      },
    })

  // First fire admits and occupies the installation's one slot.
  await fire()
  const activeRun = await prisma.workflowRun.findFirstOrThrow({
    where: { installationId: installation.id },
  })
  await prisma.workflowRun.update({
    where: { id: activeRun.id },
    data: { status: 'running', startedAt: new Date() },
  })

  // Two overlapping fires while the slot is taken.
  await fire()
  await fire()

  const runs = await prisma.workflowRun.findMany({
    where: { installationId: installation.id },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.id, activeRun.id)

  const deliveries = await prisma.agentTriggerDelivery.findMany({
    orderBy: { createdAt: 'asc' },
    where: { triggerId: trigger.id },
  })
  assert.equal(deliveries.length, 3)
  assert.equal(deliveries[0]?.status, 'delivered')
  for (const skipped of deliveries.slice(1)) {
    assert.equal(skipped.status, 'skipped_overlap')
    assert.equal(skipped.errorMessage, 'skipped_overlap')
  }

  // The admitted fire enqueued exactly one execute job for its run.
  const jobs = await prisma.$queryRaw<Array<{ idempotencyKey: string }>>`
    SELECT idempotency_key AS "idempotencyKey"
    FROM queue_jobs
    WHERE topic = 'workflow.run.execute'
      AND payload->>'workflowRunId' = ${activeRun.id}
  `
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.idempotencyKey, `workflow-run:start:${activeRun.id}`)
})
