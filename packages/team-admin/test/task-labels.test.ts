import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  createProjectLabel,
  deleteProjectLabel,
  listProjectLabels,
  setTaskLabels,
  updateProjectLabel,
  updateProjectTask,
  type BoardSourceWriteBack,
} from '../src/index.js'
import { eventsOf, seedTaskActivity } from './task-activity-db-fixture.js'

/**
 * Labels are the shared functions behind the label routes, the MCP label tools
 * and the worker's ticket tools. Against a real database, because uniqueness
 * by normalised name and the source-owned partition are both queries.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const labelsOf = async (prisma: PrismaClient, taskId: string) =>
  (await prisma.taskLabelLink.findMany({ where: { taskId }, select: { labelId: true } }))
    .map((link) => link.labelId)
    .sort()

runDatabaseTest('label CRUD refuses a second label with the same normalised name', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const project = { id: s.projectId, organizationId: s.organizationId }

  const bug = await createProjectLabel(prisma, project, { name: '  Bug ', color: '#EF4444', createdByUserId: s.memberId })
  assert.ok(!('error' in bug))
  assert.equal(bug.name, 'Bug')
  assert.equal(bug.color, '#ef4444')
  assert.equal(bug.external, false)

  const again = await createProjectLabel(prisma, project, { name: 'bug', createdByUserId: s.memberId })
  assert.ok('error' in again && again.error === 'LABEL_NAME_TAKEN')
  assert.equal(again.existing.id, bug.id, 'the taken error hands back the existing label')

  const perf = await createProjectLabel(prisma, project, { name: 'Perf', createdByUserId: s.memberId })
  assert.ok(!('error' in perf))
  const clash = await updateProjectLabel(prisma, s.projectId, perf.id, { name: 'BUG' })
  assert.ok('error' in clash && clash.error === 'LABEL_NAME_TAKEN')

  const recoloured = await updateProjectLabel(prisma, s.projectId, perf.id, { name: 'Performance', color: '#22c55e' })
  assert.ok(!('error' in recoloured))
  assert.equal(recoloured.name, 'Performance')

  // Another project may use the same name.
  const elsewhere = await createProjectLabel(prisma, { id: s.otherProjectId, organizationId: s.organizationId }, {
    name: 'Bug', createdByUserId: s.memberId,
  })
  assert.ok(!('error' in elsewhere))

  await prisma.taskLabelLink.create({ data: { taskId: s.nativeTaskId, labelId: bug.id } })
  const listed = await listProjectLabels(prisma, s.projectId)
  assert.deepEqual(listed.map((label) => [label.name, label.taskCount]), [['Bug', 1], ['Performance', 0]])

  assert.deepEqual(await deleteProjectLabel(prisma, s.projectId, bug.id), { ok: true })
  assert.deepEqual(await labelsOf(prisma, s.nativeTaskId), [], 'links cascade with the label')
  assert.deepEqual(await deleteProjectLabel(prisma, s.otherProjectId, perf.id), { error: 'LABEL_NOT_FOUND' })
  assert.deepEqual(await deleteProjectLabel(prisma, s.projectId, 'not-a-uuid'), { error: 'LABEL_NOT_FOUND' })
})

const seedLabels = async (prisma: PrismaClient, s: Awaited<ReturnType<typeof seedTaskActivity>>) => {
  const make = (name: string, sourceId: string | null, externalId: string | null) =>
    prisma.taskLabel.create({
      data: {
        organizationId: s.organizationId,
        projectId: s.projectId,
        name,
        normalizedName: name.toLowerCase(),
        sourceId,
        externalId,
      },
    })
  return {
    ownedA: await make('Owned A', s.sourceId, 'lin-a'),
    ownedB: await make('Owned B', s.sourceId, 'lin-b'),
    foreign: await make('Foreign', s.otherSourceId, 'lin-x'),
    local: await make('Local', null, null),
  }
}

const standInWriteBack = (
  prisma: PrismaClient,
  mode: 'read_only' | 'read_write',
): BoardSourceWriteBack & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    apply: async ({ taskId, change }) => {
      calls.push(change)
      if (mode === 'read_only') {
        return { error: 'SOURCE_READ_ONLY', provider: 'linear', detail: 'Linear owns this ticket.' }
      }
      // The echo: the provider now carries exactly these labels, and the
      // mirror follows it — the source-owned links become the echoed set.
      const echoed = await prisma.taskLabel.findMany({
        where: { externalId: { in: change.labelIds ?? [] } },
        select: { id: true, sourceId: true },
      })
      const owned = await prisma.taskLabelLink.findMany({
        where: { taskId, label: { sourceId: { not: null } } },
        select: { labelId: true },
      })
      await prisma.taskLabelLink.deleteMany({ where: { taskId, labelId: { in: owned.map((link) => link.labelId) } } })
      await prisma.taskLabelLink.createMany({ data: echoed.map((label) => ({ taskId, labelId: label.id })) })
      return { ok: true }
    },
  }
}

runDatabaseTest('setTaskLabels writes Nessie-only labels locally and asks the provider only for its own', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const labels = await seedLabels(prisma, s)

  // A read-only source: a Nessie-only change goes through without asking.
  const readOnly = standInWriteBack(prisma, 'read_only')
  const local = await setTaskLabels(prisma, s.member, { taskId: s.mirroredTaskId, labelIds: [labels.local.id] }, readOnly)
  assert.deepEqual(local, { added: [labels.local.id], removed: [] })
  assert.equal(readOnly.calls.length, 0, 'an unchanged source-owned subset is never written back')

  // …but a source-owned change is refused, and nothing is written.
  const refused = await setTaskLabels(prisma, s.member, {
    taskId: s.mirroredTaskId,
    labelIds: [labels.local.id, labels.ownedA.id],
  }, readOnly)
  assert.ok('error' in refused && refused.error === 'SOURCE_READ_ONLY')
  assert.deepEqual(await labelsOf(prisma, s.mirroredTaskId), [labels.local.id])

  // A label another source owns cannot mean anything upstream here.
  const foreign = await setTaskLabels(prisma, s.member, {
    taskId: s.mirroredTaskId,
    labelIds: [labels.foreign.id],
  }, readOnly)
  assert.deepEqual(foreign, { error: 'LABEL_NOT_IN_PROJECT_SOURCE', labelId: labels.foreign.id })

  // A read & write source: the provider gets the full desired owned set, the
  // echo rewrites those links, and the Nessie-only label survives.
  const readWrite = standInWriteBack(prisma, 'read_write')
  const written = await setTaskLabels(prisma, s.member, {
    taskId: s.mirroredTaskId,
    labelIds: [labels.local.id, labels.ownedA.id, labels.ownedB.id],
  }, readWrite)
  assert.ok(!('error' in written))
  assert.deepEqual(readWrite.calls, [{ labelIds: ['lin-a', 'lin-b'] }])
  assert.deepEqual(await labelsOf(prisma, s.mirroredTaskId), [labels.local.id, labels.ownedA.id, labels.ownedB.id].sort())

  // Removing the Nessie-only label leaves the provider alone.
  await setTaskLabels(prisma, s.member, {
    taskId: s.mirroredTaskId,
    labelIds: [labels.ownedA.id, labels.ownedB.id],
  }, readWrite)
  assert.equal(readWrite.calls.length, 1)
  assert.deepEqual(await labelsOf(prisma, s.mirroredTaskId), [labels.ownedA.id, labels.ownedB.id].sort())

  // History rows carry who and what.
  const history = await eventsOf(prisma, s.mirroredTaskId, 'labels_changed')
  assert.equal(history.length, 3)
  assert.deepEqual(history[2], { by: s.memberId, added: [], removed: [labels.local.id] })

  // A label from another project, and an outsider, are refused.
  const otherProjectLabel = await prisma.taskLabel.create({
    data: { organizationId: s.organizationId, projectId: s.otherProjectId, name: 'X', normalizedName: 'x' },
  })
  assert.deepEqual(
    await setTaskLabels(prisma, s.member, { taskId: s.nativeTaskId, labelIds: [otherProjectLabel.id] }),
    { error: 'LABEL_NOT_IN_PROJECT', labelId: otherProjectLabel.id },
  )
  assert.deepEqual(
    await setTaskLabels(prisma, s.outsider, { taskId: s.nativeTaskId, labelIds: [] }),
    { error: 'NOT_FOUND' },
  )
})

runDatabaseTest('updateProjectTask writes labels and a detail_edited row in one call', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const labels = await seedLabels(prisma, s)
  const result = await updateProjectTask(prisma, {
    taskId: s.nativeTaskId,
    organizationId: s.organizationId,
    fields: { detail: '## Heading', labelIds: [labels.local.id, labels.ownedA.id] },
    actorId: s.memberId,
  })
  assert.ok(!('error' in result))
  // A native ticket keeps any of the project's labels locally.
  assert.deepEqual(result.labels.map((label) => label.name), ['Local', 'Owned A'])
  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'detail_edited'), [{ by: s.memberId }])
  assert.equal((await eventsOf(prisma, s.nativeTaskId, 'labels_changed')).length, 1)

  // An unchanged description writes no history line.
  await updateProjectTask(prisma, {
    taskId: s.nativeTaskId, organizationId: s.organizationId, fields: { detail: '## Heading' }, actorId: s.memberId,
  })
  assert.equal((await eventsOf(prisma, s.nativeTaskId, 'detail_edited')).length, 1)
})
