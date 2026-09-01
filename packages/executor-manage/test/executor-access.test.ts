import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canManageExecutor,
  canViewExecutor,
} from '../src/executor-access.js'

const privateExecutor = {
  id: 'executor-private',
  projectId: null,
  scopeKind: 'private' as const,
}

test('only a named human private admin manages a private executor', () => {
  assert.equal(canViewExecutor(privateExecutor, {
    organizationRole: 'owner',
    privateAssignment: 'none',
    projectRole: null,
  }), false)
  assert.equal(canManageExecutor(privateExecutor, {
    organizationRole: 'member',
    privateAssignment: 'use',
    projectRole: null,
  }), false)
  assert.equal(canManageExecutor(privateExecutor, {
    organizationRole: 'member',
    privateAssignment: 'admin',
    projectRole: null,
  }), true)
})

test('project management is explicit while organization executors are organization-administered', () => {
  const projectExecutor = { id: 'executor-project', projectId: 'project', scopeKind: 'project' as const }
  const organizationExecutor = { id: 'executor-org', projectId: null, scopeKind: 'organization' as const }
  assert.equal(canManageExecutor(projectExecutor, {
    organizationRole: 'member',
    privateAssignment: 'none',
    projectRole: 'admin',
  }), true)
  assert.equal(canManageExecutor(organizationExecutor, {
    organizationRole: 'member',
    privateAssignment: 'none',
    projectRole: 'owner',
  }), false)
})
