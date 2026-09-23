import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  createBoardLabel,
  createProjectTask,
  deleteBoard,
  deleteBoardLabel,
  listBoardLabels,
  listProjectLabels,
  moveProjectTaskToColumn,
  setTaskLabels,
  updateBoardLabel,
  updateProjectTask,
  type BoardSourceWriteBack,
} from '../src/index.js'
import { createLabel, eventsOf, seedTaskActivity, type TaskActivitySeed } from './task-activity-db-fixture.js'

/**
 * Labels are the shared functions behind the label routes, the MCP label tools
 * and the worker's ticket tools. Against a real database, because uniqueness
 * by normalised name per board, the source-owned partition and the re-homing
 * of a ticket's labels are all queries.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const labelsOf = async (prisma: PrismaClient, taskId: string) =>
  (await prisma.taskLabelLink.findMany({ where: { taskId }, select: { labelId: true } }))
    .map((link) => link.labelId)
    .sort()

const labelRowsOf = async (prisma: PrismaClient, taskId: string) =>
  (await prisma.taskLabelLink.findMany({
    where: { taskId },
    select: { label: { select: { id: true, boardId: true, name: true, color: true, sourceId: true, externalId: true } } },
  }))
    .map((link) => link.label)
    .sort((a, b) => a.name.localeCompare(b.name))

runDatabaseTest('a label name is unique on its board, and two boards may share it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })

  const bug = await createBoardLabel(prisma, s.board, { name: '  Bug ', color: '#EF4444', createdByUserId: s.memberId })
  assert.ok(!('error' in bug))
  assert.equal(bug.name, 'Bug')
  assert.equal(bug.color, '#ef4444')
  assert.equal(bug.external, false)
  assert.equal(bug.boardId, s.board.id)

  const again = await createBoardLabel(prisma, s.board, { name: 'bug', createdByUserId: s.memberId })
  assert.ok('error' in again && again.error === 'LABEL_NAME_TAKEN')
  assert.equal(again.existing.id, bug.id, 'the taken error hands back the board\'s existing label')

  // The same name on the project's other board is a second label.
  const devBug = await createBoardLabel(prisma, s.devBoard, { name: 'Bug', color: '#3b82f6', createdByUserId: s.memberId })
  assert.ok(!('error' in devBug))
  assert.notEqual(devBug.id, bug.id)
  assert.equal(devBug.boardId, s.devBoard.id)

  const perf = await createBoardLabel(prisma, s.board, { name: 'Perf', createdByUserId: s.memberId })
  assert.ok(!('error' in perf))
  const clash = await updateBoardLabel(prisma, s.board, perf.id, { name: 'BUG' })
  assert.ok('error' in clash && clash.error === 'LABEL_NAME_TAKEN')
  // Another board's label is not this board's to change.
  assert.deepEqual(await updateBoardLabel(prisma, s.devBoard, perf.id, { name: 'X' }), { error: 'LABEL_NOT_FOUND' })

  const recoloured = await updateBoardLabel(prisma, s.board, perf.id, { name: 'Performance', color: '#22c55e' })
  assert.ok(!('error' in recoloured))
  assert.equal(recoloured.name, 'Performance')

  await prisma.taskLabelLink.create({ data: { taskId: s.nativeTaskId, labelId: bug.id } })
  const listed = await listBoardLabels(prisma, s.board.id)
  assert.deepEqual(listed.map((label) => [label.name, label.taskCount]), [['Bug', 1], ['Performance', 0]])
  assert.deepEqual((await listBoardLabels(prisma, s.devBoard.id)).map((label) => label.id), [devBug.id])
  // The project-wide read: every board's, board order then name, each naming its board.
  assert.deepEqual(
    (await listProjectLabels(prisma, s.projectId)).map((label) => [label.boardId, label.name]),
    [[s.board.id, 'Bug'], [s.board.id, 'Performance'], [s.devBoard.id, 'Bug']],
  )

  assert.deepEqual(await deleteBoardLabel(prisma, s.devBoard, bug.id), { error: 'LABEL_NOT_FOUND' })
  assert.deepEqual(await deleteBoardLabel(prisma, s.board, bug.id), { ok: true })
  assert.deepEqual(await labelsOf(prisma, s.nativeTaskId), [], 'links cascade with the label')
  assert.deepEqual(await deleteBoardLabel(prisma, s.board, 'not-a-uuid'), { error: 'LABEL_NOT_FOUND' })
})

const seedLabels = async (prisma: PrismaClient, s: TaskActivitySeed) => ({
  ownedA: await createLabel(prisma, s.board, 'Owned A', { sourceId: s.sourceId, externalId: 'lin-a' }),
  ownedB: await createLabel(prisma, s.board, 'Owned B', { sourceId: s.sourceId, externalId: 'lin-b' }),
  foreign: await createLabel(prisma, s.board, 'Foreign', { sourceId: s.otherSourceId, externalId: 'lin-x' }),
  local: await createLabel(prisma, s.board, 'Local'),
})

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
  assert.deepEqual(foreign, { error: 'LABEL_NOT_IN_TASK_SOURCE', labelId: labels.foreign.id })

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

  // History rows carry who, through which door, and what. The seed's actor
  // names no door, so it is the platform's: it can start no agent's work.
  const history = await eventsOf(prisma, s.mirroredTaskId, 'labels_changed')
  assert.equal(history.length, 3)
  assert.deepEqual(history[2], {
    by: s.memberId,
    origin: { kind: 'system' },
    added: [],
    removed: [labels.local.id],
  })

  // A label from another project, and an outsider, are refused.
  const otherProjectLabel = await createLabel(prisma, s.otherProjectBoard, 'X')
  assert.deepEqual(
    await setTaskLabels(prisma, s.member, { taskId: s.nativeTaskId, labelIds: [otherProjectLabel.id] }),
    { error: 'LABEL_NOT_ON_BOARD', labelId: otherProjectLabel.id },
  )
  assert.deepEqual(
    await setTaskLabels(prisma, s.outsider, { taskId: s.nativeTaskId, labelIds: [] }),
    { error: 'NOT_FOUND' },
  )
})

runDatabaseTest('a ticket takes only its own board\'s labels; boardId null is the default board', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const onDefault = await createLabel(prisma, s.board, 'Bug')
  const onDev = await createLabel(prisma, s.devBoard, 'Bug')

  // The native ticket has `boardId: null`: its board is the project's default.
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: s.nativeTaskId } })).boardId, null)
  assert.deepEqual(
    await setTaskLabels(prisma, s.member, { taskId: s.nativeTaskId, labelIds: [onDev.id] }),
    { error: 'LABEL_NOT_ON_BOARD', labelId: onDev.id },
    'the same project, another board',
  )
  assert.deepEqual(
    await setTaskLabels(prisma, s.member, { taskId: s.nativeTaskId, labelIds: [onDefault.id] }),
    { added: [onDefault.id], removed: [] },
  )

  // On Dev the answer flips.
  await prisma.task.update({ where: { id: s.nativeTaskId }, data: { boardId: s.devBoard.id } })
  const refused = await updateProjectTask(prisma, {
    taskId: s.nativeTaskId,
    organizationId: s.organizationId,
    fields: { labelIds: [onDefault.id] },
    actorId: s.memberId,
  })
  assert.deepEqual(refused, { error: 'LABEL_NOT_ON_BOARD', labelId: onDefault.id })

  // A create validates against the board it lands on.
  const base = {
    actorContext: {} as never,
    organizationId: s.organizationId,
    createdByUserId: s.memberId,
    title: 'New',
    projectId: s.projectId,
  }
  assert.deepEqual(
    await createProjectTask(prisma, { ...base, labelIds: [onDev.id] }),
    { error: 'LABEL_NOT_ON_BOARD', labelId: onDev.id },
    'no boardId lands on the default board',
  )
  const created = await createProjectTask(prisma, { ...base, boardId: s.devBoard.id, labelIds: [onDev.id] })
  assert.ok(!('error' in created))
  assert.deepEqual(created.labels.map((label) => label.id), [onDev.id])
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
  // A native ticket keeps any of its board's labels locally.
  assert.deepEqual(result.labels.map((label) => label.name), ['Local', 'Owned A'])
  assert.deepEqual(
    await eventsOf(prisma, s.nativeTaskId, 'detail_edited'),
    [{ by: s.memberId, origin: { kind: 'system' } }],
  )
  assert.equal((await eventsOf(prisma, s.nativeTaskId, 'labels_changed')).length, 1)

  // An unchanged description writes no history line.
  await updateProjectTask(prisma, {
    taskId: s.nativeTaskId, organizationId: s.organizationId, fields: { detail: '## Heading' }, actorId: s.memberId,
  })
  assert.equal((await eventsOf(prisma, s.nativeTaskId, 'detail_edited')).length, 1)
})

runDatabaseTest('a ticket moved to another board keeps its labels by name', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const local = await createLabel(prisma, s.board, 'Local', null, '#ef4444')
  const owned = await createLabel(prisma, s.board, 'Owned', { sourceId: s.sourceId, externalId: 'lin-o' }, '#22c55e')
  const adoptable = await createLabel(prisma, s.board, 'Adopt', { sourceId: s.sourceId, externalId: 'lin-adopt' })
  // Dev already has the source's label under a local rename, and a Nessie-only "adopt".
  const devOwned = await createLabel(prisma, s.devBoard, 'Owned (renamed)', { sourceId: s.sourceId, externalId: 'lin-o' })
  const devAdopt = await createLabel(prisma, s.devBoard, 'adopt')
  await prisma.taskLabelLink.createMany({
    data: [local, owned, adoptable].map((label) => ({ taskId: s.mirroredTaskId, labelId: label.id })),
  })

  const moved = await moveProjectTaskToColumn(prisma, {
    taskId: s.mirroredTaskId,
    organizationId: s.organizationId,
    columnId: s.devColumnId,
    actorId: s.memberId,
  })
  assert.ok(!('error' in moved))
  assert.equal(moved.boardId, s.devBoard.id)

  const after = await labelRowsOf(prisma, s.mirroredTaskId)
  assert.ok(after.every((label) => label.boardId === s.devBoard.id), 'every label is now the new board\'s')
  const byName = new Map(after.map((label) => [label.name, label]))
  // Nessie-only: created on Dev with its name and colour.
  const createdLocal = byName.get('Local')
  assert.ok(createdLocal && createdLocal.id !== local.id)
  assert.equal(createdLocal.color, '#ef4444')
  assert.equal(createdLocal.sourceId, null)
  // Source-owned: found by (sourceId, externalId), whatever it is called on Dev.
  assert.equal(byName.get('Owned (renamed)')?.id, devOwned.id)
  // A same-name Nessie-only label on Dev is adopted by the source.
  const adopted = byName.get('adopt')
  assert.equal(adopted?.id, devAdopt.id)
  assert.equal(adopted?.sourceId, s.sourceId)
  assert.equal(adopted?.externalId, 'lin-adopt')
  assert.equal(after.length, 3)

  // The old board's labels are untouched, only no longer on this ticket.
  assert.equal(await prisma.taskLabel.count({ where: { boardId: s.board.id } }), 3)

  const [rehomed] = await eventsOf(prisma, s.mirroredTaskId, 'labels_rehomed')
  assert.equal(rehomed?.['by'], s.memberId)
  assert.equal(rehomed?.['fromBoardId'], s.board.id)
  assert.equal(rehomed?.['toBoardId'], s.devBoard.id)
  assert.deepEqual(
    (rehomed?.['mapping'] as { from: string; to: string }[]).map((pair) => [pair.from, pair.to]).sort(),
    [[local.id, createdLocal.id], [owned.id, devOwned.id], [adoptable.id, devAdopt.id]].sort(),
  )

  // A move within the board re-homes nothing and writes no second event.
  await moveProjectTaskToColumn(prisma, {
    taskId: s.mirroredTaskId, organizationId: s.organizationId, columnId: s.devColumnId, actorId: s.memberId,
  })
  assert.equal((await eventsOf(prisma, s.mirroredTaskId, 'labels_rehomed')).length, 1)
})

runDatabaseTest('deleting a board leaves its labels, and their links, on the default board', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const devOnly = await createLabel(prisma, s.devBoard, 'Dev only', null, '#a855f7')
  const devBug = await createLabel(prisma, s.devBoard, 'Bug')
  const defaultBug = await createLabel(prisma, s.board, 'bug')
  await prisma.task.update({ where: { id: s.nativeTaskId }, data: { boardId: s.devBoard.id } })
  await prisma.taskLabelLink.createMany({
    data: [devOnly, devBug].map((label) => ({ taskId: s.nativeTaskId, labelId: label.id })),
  })

  assert.deepEqual(await deleteBoard(prisma, s.projectId, s.devBoard.id), { ok: true })

  const task = await prisma.task.findUniqueOrThrow({ where: { id: s.nativeTaskId } })
  assert.equal(task.boardId, null, 'the ticket fell back to the default board')
  const labels = await labelRowsOf(prisma, s.nativeTaskId)
  assert.deepEqual(labels.map((label) => [label.name, label.boardId]), [['bug', s.board.id], ['Dev only', s.board.id]])
  // A label with no equivalent moves as the same row; a same-name one merges.
  assert.equal(labels.find((label) => label.name === 'Dev only')?.id, devOnly.id)
  assert.equal(labels.find((label) => label.name === 'bug')?.id, defaultBug.id)
  assert.equal(await prisma.taskLabel.count({ where: { id: devBug.id } }), 0, 'the emptied duplicate is gone')
  assert.equal(await prisma.taskLabel.count({ where: { projectId: s.projectId } }), 2)
})
