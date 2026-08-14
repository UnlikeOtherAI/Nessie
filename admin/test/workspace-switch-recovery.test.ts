import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import {
  AuthSessionApiError,
  createSessionMutationCoordinator,
  type SessionPayload,
} from '@nessie/client-core'
import { recoverWorkspaceSwitchFailure } from '../src/layouts/admin-shell/workspace-switch-recovery.js'
import type { Workspace } from '../src/lib/workspaces.js'
import { createSessionQueryBoundary } from '../src/providers/auth-session-query-reset.js'

const source: Workspace = {
  active: true,
  label: 'Alpha',
  organizationId: 'org-a',
  projectId: '',
  teamId: 'team-a',
  uoaWorkspace: true,
}

const target: Workspace = {
  active: false,
  label: 'Beta',
  organizationId: 'org-b',
  projectId: '',
  teamId: 'team-b',
  uoaWorkspace: true,
}

const payload = (active: Workspace): SessionPayload => ({
  me: {
    auth: { providerId: 'uoa', providerType: 'uoa', autoRedirectToSso: false },
    context: {
      bootstrapMode: false,
      organizationId: 'local-org',
      projectId: 'local-project',
      teamId: `local-${active.teamId}`,
    },
    user: { id: 'user-a' },
    uoaWorkspaces: [source, target].map((workspace) => ({
      active: workspace.teamId === active.teamId,
      label: workspace.label,
      organizationId: workspace.organizationId,
      teamId: workspace.teamId,
    })),
  } as unknown as MeResponse,
  token: `token-${active.teamId}`,
})

test('lost switch response reconciles the committed target as success', async () => {
  let currentMe = payload(source).me
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (session) => {
      events.push('apply')
      currentMe = session.me
    },
    beforeApply: boundary.beforeApply,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => payload(target),
  })
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: source,
    error: new TypeError('response body was lost'),
    reconcileSession: coordinator.reconcile,
    targetWorkspace: target,
  })

  assert.deepEqual(result, { outcome: 'switched' })
  assert.deepEqual(events, ['cancel', 'clear', 'apply'])
})

test('ambiguous conflict reports the workspace returned by reconciliation', async () => {
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: source,
    error: new AuthSessionApiError('conflict', 'WORKSPACE_SWITCH_CONFLICT', 409),
    reconcileSession: async () => payload(source),
    targetWorkspace: target,
  })

  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /still in Alpha/)
  }
})

test('unavailable target refreshes the directory and reports its current workspace', async () => {
  let reconcileCalls = 0
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: target,
    error: new AuthSessionApiError('revoked', 'WORKSPACE_NOT_AVAILABLE', 403),
    reconcileSession: async () => {
      reconcileCalls += 1
      return payload(source)
    },
    targetWorkspace: target,
  })

  assert.equal(reconcileCalls, 1)
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /still in Alpha/)
    assert.doesNotMatch(result.message, /still in Beta/)
  }
})

test('failed reconciliation never claims that the source was retained', async () => {
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: source,
    error: new TypeError('network failed'),
    reconcileSession: async () => {
      throw new TypeError('still offline')
    },
    targetWorkspace: target,
  })

  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /Couldn’t confirm whether the switch to Beta completed/)
    assert.doesNotMatch(result.message, /still in Alpha/)
  }
})

test('interaction-required remains explicit and does not consume another refresh', async () => {
  let reconcileCalls = 0
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: source,
    error: new AuthSessionApiError('verify', 'INTERACTION_REQUIRED', 403),
    reconcileSession: async () => {
      reconcileCalls += 1
      return payload(source)
    },
    targetWorkspace: target,
  })

  assert.equal(reconcileCalls, 0)
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /requires another sign-in verification/)
  }
})

test('authentication loss during reconciliation asks for sign-in', async () => {
  let reconcileCalls = 0
  const result = await recoverWorkspaceSwitchFailure({
    currentWorkspace: source,
    error: new AuthSessionApiError('expired', 'INVALID_REFRESH_TOKEN', 401),
    reconcileSession: async () => {
      reconcileCalls += 1
      return null
    },
    targetWorkspace: target,
  })

  assert.equal(reconcileCalls, 1)
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /Sign in again/)
    assert.doesNotMatch(result.message, /still in Alpha/)
  }
})
