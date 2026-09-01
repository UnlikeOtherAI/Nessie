import assert from 'node:assert/strict'
import test from 'node:test'

import { getAttentionSummary, markUserAlertsRead } from '../src/services/alerts.js'
import { TenantStore } from './conformance/tenant-store.js'

type UserAlertDelegate = {
  updateMany: (args: unknown) => Promise<{ count: number }>
}

test('a project surface clears an over-200 server snapshot but preserves an alert committed during the write', async () => {
  const store = new TenantStore()
  const projectId = 'project-1'
  const otherProjectId = 'project-2'
  const projectAlertCount = 201
  const concurrentAlertId = '00000000-0000-4000-8000-000000000113'
  const replacementAlertId = '00000000-0000-4000-8000-000000000115'
  const otherProjectAlertId = '00000000-0000-4000-8000-000000000114'

  store.seed('user', [{ id: 'user-1' }])
  store.seed('organizationMember', [{
    id: 'org-member-1', organizationId: 'org-1', userId: 'user-1', deactivatedAt: null,
  }])
  store.seed('project', [
    { id: projectId, organizationId: 'org-1' },
    { id: otherProjectId, organizationId: 'org-1' },
  ])
  store.seed('projectMember', [
    { id: 'project-member-1', projectId, userId: 'user-1' },
    { id: 'project-member-2', projectId: otherProjectId, userId: 'user-1' },
  ])
  store.seed('task', [
    ...Array.from({ length: projectAlertCount }, (_, index) => ({
      id: `task-${index}`,
      organizationId: 'org-1',
      projectId,
      assigneeUserId: 'user-1',
      status: 'todo',
      archivedAt: null,
    })),
    { id: 'task-other', organizationId: 'org-1', projectId: otherProjectId, assigneeUserId: 'user-1', status: 'todo', archivedAt: null },
  ])
  store.seed('userAlert', [
    ...Array.from({ length: projectAlertCount }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, '0')}`,
      organizationId: 'org-1',
      userId: 'user-1',
      kind: 'task_assigned',
      projectId,
      taskId: `task-${index}`,
      readAt: null,
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
    })),
    { id: otherProjectAlertId, organizationId: 'org-1', userId: 'user-1', kind: 'task_assigned', projectId: otherProjectId, taskId: 'task-other', readAt: null, createdAt: new Date('2026-08-12T09:30:00.000Z') },
  ])

  const client = store.client
  const snapshot = await getAttentionSummary(client, { organizationId: 'org-1', userId: 'user-1' })
  const snapshotVersion = snapshot.assignedWork.versions[projectId]
  assert.ok(snapshotVersion)
  const userAlert = client.userAlert as unknown as UserAlertDelegate
  const updateMany = userAlert.updateMany
  userAlert.updateMany = async (args) => {
    // This matches the critical production interleaving: a new alert commits
    // after the service selected its snapshot but before the exact-ID update.
    store.seed('userAlert', [{
      id: concurrentAlertId,
      organizationId: 'org-1',
      userId: 'user-1',
      kind: 'task_assigned',
      projectId,
      taskId: 'task-3',
      readAt: null,
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
    }])
    return updateMany(args)
  }

  const result = await markUserAlertsRead(client, {
    organizationId: 'org-1',
    userId: 'user-1',
    surface: {
      kind: 'task_assigned',
      projectId,
    },
  })

  assert.equal(result.read, projectAlertCount)
  const rows = store.rows('userAlert')
  assert.equal(
    rows.filter((row) => row['projectId'] === projectId && row['readAt'] instanceof Date).length,
    projectAlertCount,
  )
  assert.equal(rows.find((row) => row['id'] === concurrentAlertId)?.['readAt'], null)
  assert.equal(rows.find((row) => row['id'] === otherProjectAlertId)?.['readAt'], null)

  const after = await getAttentionSummary(client, { organizationId: 'org-1', userId: 'user-1' })
  assert.equal(after.assignedWork.projects[projectId], 1)
  assert.notEqual(after.assignedWork.versions[projectId], snapshotVersion)

  // A reassignment can retire one alert while adding another, keeping the
  // count at one. The opaque version must still make the open Board re-clear.
  const concurrent = rows.find((row) => row['id'] === concurrentAlertId)
  assert.ok(concurrent)
  concurrent['readAt'] = new Date()
  store.seed('userAlert', [{
    id: replacementAlertId,
    organizationId: 'org-1',
    userId: 'user-1',
    kind: 'task_assigned',
    projectId,
    taskId: 'task-3',
    readAt: null,
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
  }])
  const replacement = await getAttentionSummary(client, { organizationId: 'org-1', userId: 'user-1' })
  assert.equal(replacement.assignedWork.projects[projectId], 1)
  assert.notEqual(replacement.assignedWork.versions[projectId], after.assignedWork.versions[projectId])
})
