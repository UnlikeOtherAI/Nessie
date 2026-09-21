import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { registerTaskLabelRoutes } from '../src/routes/task-labels.js'
import { registerTaskRoutes } from '../src/routes/tasks.js'
import { createRouteHarness } from './task-activity-route-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('label routes: members manage labels, a clash returns the existing label, cards repaint', async (t) => {
  const prisma = new PrismaClient()
  const h = await createRouteHarness(prisma, [registerTaskLabelRoutes])
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })
  const base = `/api/projects/${h.ids.projectId}/labels`

  const created = await h.app.inject({ method: 'POST', url: base, payload: { name: 'Bug', color: '#ef4444' } })
  assert.equal(created.statusCode, 201, created.body)
  const bug = JSON.parse(created.body).data
  assert.equal(bug.external, false)

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

  // Somebody outside the project neither reads nor changes its labels.
  h.as(h.ids.outsiderId)
  assert.equal((await h.app.inject({ method: 'GET', url: base })).statusCode, 404)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 404)
  h.as(h.ids.memberId)

  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 204)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${bug.id}` })).statusCode, 404)
  assert.deepEqual(
    h.published.map((event) => event.event),
    ['board.updated', 'board.updated', 'board.updated'],
    'create, rename and delete each repaint the cards',
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
    method: 'POST', url: `/api/projects/${h.ids.projectId}/labels`, payload: { name: 'Perf' },
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

  // A label from nowhere is a 400 naming the field.
  const unknown = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.ids.taskId}`,
    payload: { labelIds: ['00000000-0000-4000-8000-000000000000'] },
  })
  assert.equal(unknown.statusCode, 400)
  assert.equal(JSON.parse(unknown.body).error.code, 'LABEL_NOT_IN_PROJECT')

  // Create takes labels too.
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { title: 'Labelled', projectId: h.ids.projectId, labelIds: [label.id] },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.deepEqual(JSON.parse(created.body).data.labels.map((entry: { id: string }) => entry.id), [label.id])
})
