import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { registerTaskLabelRoutes } from '../src/routes/task-labels.js'
import { registerTaskRoutes } from '../src/routes/tasks.js'
import { createRouteHarness } from './task-activity-route-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('label routes: members manage a board\'s labels, a clash returns the existing label, cards repaint', async (t) => {
  const prisma = new PrismaClient()
  const h = await createRouteHarness(prisma, [registerTaskLabelRoutes])
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })
  const base = `/api/projects/${h.ids.projectId}/boards/${h.ids.defaultBoardId}/labels`
  const devBase = `/api/projects/${h.ids.projectId}/boards/${h.ids.devBoardId}/labels`

  const created = await h.app.inject({ method: 'POST', url: base, payload: { name: 'Bug', color: '#ef4444' } })
  assert.equal(created.statusCode, 201, created.body)
  const bug = JSON.parse(created.body).data
  assert.equal(bug.external, false)
  assert.equal(bug.boardId, h.ids.defaultBoardId)

  // The same name is free on the project's other board.
  const devBug = await h.app.inject({ method: 'POST', url: devBase, payload: { name: 'Bug' } })
  assert.equal(devBug.statusCode, 201, devBug.body)
  assert.equal(JSON.parse(devBug.body).data.boardId, h.ids.devBoardId)

  // A board of another project, or no board at all, is a 404.
  const stray = `/api/projects/${h.ids.projectId}/boards/00000000-0000-4000-8000-000000000000/labels`
  const strayRead = await h.app.inject({ method: 'GET', url: stray })
  assert.equal(strayRead.statusCode, 404)
  assert.equal(JSON.parse(strayRead.body).error.code, 'BOARD_NOT_FOUND')
  assert.equal((await h.app.inject({ method: 'POST', url: stray, payload: { name: 'X' } })).statusCode, 404)
  // Another board's label is not found through this board's path.
  assert.equal(
    (await h.app.inject({ method: 'PATCH', url: `${devBase}/${bug.id}`, payload: { name: 'Nope' } })).statusCode,
    404,
  )

  const clash = await h.app.inject({ method: 'POST', url: base, payload: { name: ' BUG ' } })
  assert.equal(clash.statusCode, 409)
  const error = JSON.parse(clash.body).error
  assert.equal(error.code, 'LABEL_NAME_TAKEN')
  assert.equal(error.details.label.id, bug.id)

  const invalid = await h.app.inject({ method: 'POST', url: base, payload: { name: 'X', color: 'red' } })
  assert.equal(invalid.statusCode, 400)

  const renamed = await h.app.inject({ method: 'PATCH', url: `${base}/${bug.id}`, payload: { name: 'Defect' } })
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.equal(JSON.parse(renamed.body).data.name, 'Defect')

  const listed = await h.app.inject({ method: 'GET', url: base })
  assert.deepEqual(
    JSON.parse(listed.body).data.labels.map((label: { name: string; taskCount: number }) => [label.name, label.taskCount]),
    [['Defect', 0]],
  )
  // The project-wide read stays: every board's, each naming its board.
  const projectWide = await h.app.inject({ method: 'GET', url: `/api/projects/${h.ids.projectId}/labels` })
  assert.deepEqual(
    JSON.parse(projectWide.body).data.labels.map((label: { name: string; boardId: string }) => [label.name, label.boardId]),
    [['Defect', h.ids.defaultBoardId], ['Bug', h.ids.devBoardId]],
  )
  // The old project-level write paths are gone.
  assert.equal(
    (await h.app.inject({ method: 'POST', url: `/api/projects/${h.ids.projectId}/labels`, payload: { name: 'Old' } })).statusCode,
    404,
  )

  // Somebody outside the project neither reads nor changes its labels.
  h.as(h.ids.outsiderId)
  assert.equal((await h.app.inject({ method: 'GET', url: base })).statusCode, 404)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 404)
  h.as(h.ids.memberId)

  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 204)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 404)
  assert.deepEqual(
    h.published.map((event) => event.event),
    ['board.updated', 'board.updated', 'board.updated', 'board.updated'],
    'creates, rename and delete each repaint the cards',
  )
  assert.deepEqual(h.published[0]?.data, { projectId: h.ids.projectId })
})

runDatabaseTest('PATCH /api/tasks/:id sets labels, records history and publishes task.updated', async (t) => {
  const prisma = new PrismaClient()
  const h = await createRouteHarness(prisma, [registerTaskLabelRoutes, registerTaskRoutes])
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })
  const label = JSON.parse((await h.app.inject({
    method: 'POST', url: `/api/projects/${h.ids.projectId}/boards/${h.ids.defaultBoardId}/labels`, payload: { name: 'Perf' },
  })).body).data
  const devLabel = JSON.parse((await h.app.inject({
    method: 'POST', url: `/api/projects/${h.ids.projectId}/boards/${h.ids.devBoardId}/labels`, payload: { name: 'Perf' },
  })).body).data
  h.published.length = 0

  const patched = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.ids.taskId}`,
    payload: { labelIds: [label.id], detail: '## New' },
  })
  assert.equal(patched.statusCode, 200, patched.body)
  const task = JSON.parse(patched.body).data
  assert.deepEqual(task.labels.map((entry: { name: string }) => entry.name), ['Perf'])
  assert.deepEqual(h.published, [{ event: 'task.updated', data: { taskId: h.ids.taskId, status: 'inbox' } }])
  const events = await prisma.taskEvent.findMany({ where: { taskId: h.ids.taskId }, orderBy: { eventType: 'asc' } })
  assert.deepEqual(events.map((event) => event.eventType), ['detail_edited', 'labels_changed'])
  assert.deepEqual(events[1]?.payload, { by: h.ids.memberId, added: [label.id], removed: [] })

  // Another board's label — or one from nowhere — is a 400 naming the field.
  for (const labelId of [devLabel.id, '00000000-0000-4000-8000-000000000000']) {
    const refused = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${h.ids.taskId}`,
      payload: { labelIds: [labelId] },
    })
    assert.equal(refused.statusCode, 400)
    const error = JSON.parse(refused.body).error
    assert.equal(error.code, 'LABEL_NOT_ON_BOARD')
    assert.equal(error.field, 'labelIds')
    assert.equal(error.details.labelId, labelId)
  }

  // Create takes labels too.
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { title: 'Labelled', projectId: h.ids.projectId, labelIds: [label.id] },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.deepEqual(JSON.parse(created.body).data.labels.map((entry: { id: string }) => entry.id), [label.id])
  // …validated against the board the ticket lands on.
  const onDev = await h.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { title: 'On Dev', projectId: h.ids.projectId, boardId: h.ids.devBoardId, labelIds: [devLabel.id] },
  })
  assert.equal(onDev.statusCode, 201, onDev.body)
})
