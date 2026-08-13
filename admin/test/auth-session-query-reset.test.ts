import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import { createSessionMutationCoordinator } from '@nessie/client-core'
import {
  createSessionQueryBoundary,
  hasSessionBoundaryChanged,
  isCurrentSessionResponse,
} from '../src/providers/auth-session-query-reset.js'

const me = (
  organizationId: string,
  projectId: string,
  teamId: string,
  userId = 'user-a',
): MeResponse => ({
  context: { bootstrapMode: false, organizationId, projectId, teamId },
  user: { id: userId },
} as unknown as MeResponse)

test('session boundary comparison covers user, organization, project, and team', () => {
  const current = me('org-a', 'project-a', 'team-a')

  assert.equal(hasSessionBoundaryChanged(null, current), false)
  assert.equal(hasSessionBoundaryChanged(current, me('org-a', 'project-a', 'team-a')), false)
  assert.equal(hasSessionBoundaryChanged(current, me('org-b', 'project-a', 'team-a')), true)
  assert.equal(hasSessionBoundaryChanged(current, me('org-a', 'project-b', 'team-a')), true)
  assert.equal(hasSessionBoundaryChanged(current, me('org-a', 'project-a', 'team-b')), true)
  assert.equal(hasSessionBoundaryChanged(current, me('org-a', 'project-a', 'team-a', 'user-b')), true)
})

test('late profile responses cannot restore an old session boundary', () => {
  const current = me('org-b', 'project-b', 'team-b', 'user-a')

  assert.equal(
    isCurrentSessionResponse(current, me('org-b', 'project-b', 'team-b', 'user-a')),
    true,
  )
  assert.equal(
    isCurrentSessionResponse(current, me('org-a', 'project-a', 'team-a', 'user-a')),
    false,
  )
  assert.equal(
    isCurrentSessionResponse(current, me('org-b', 'project-b', 'team-b', 'user-b')),
    false,
  )
  assert.equal(
    isCurrentSessionResponse(null, me('org-b', 'project-b', 'team-b', 'user-a')),
    false,
  )
})

test('ordinary refresh clears tenant queries before applying a changed context', async () => {
  let currentMe = me('org-a', 'project-a', 'team-a')
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      events.push('apply')
      currentMe = payload.me
    },
    beforeApply: boundary.beforeApply,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => ({ me: me('org-b', 'project-b', 'team-b'), token: 'target-token' }),
  })

  assert.equal(await coordinator.refresh(), 'target-token')
  assert.deepEqual(events, ['cancel', 'clear', 'apply'])
})

test('same-context refresh does not clear and an explicit switch clears once', async () => {
  let currentMe = me('org-a', 'project-a', 'team-a')
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
      currentMe = payload.me
    },
    beforeApply: boundary.beforeApply,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => ({ me: me('org-a', 'project-a', 'team-a'), token: 'renewed' }),
  })

  await coordinator.reconcile()
  await coordinator.run(async () => ({
    me: me('org-b', 'project-b', 'team-b'),
    token: 'switched',
  }))

  assert.deepEqual(events, ['apply:renewed', 'cancel', 'clear', 'apply:switched'])
})

test('authentication rejection clears cached tenant data', async () => {
  let currentMe: MeResponse | null = me('org-a', 'project-a', 'team-a', 'user-a')
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      currentMe = payload.me
      events.push(`apply:${payload.me.user.id}`)
    },
    beforeApply: boundary.beforeApply,
    clearSession: async () => {
      await boundary.clear()
      currentMe = null
      events.push('clear-session')
    },
    refresh: async () => null,
  })

  assert.equal(await coordinator.reconcile(), null)

  assert.deepEqual(events, ['cancel', 'clear', 'clear-session'])
})

test('explicit session clearing uses the same cache boundary', async () => {
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => me('org-a', 'project-a', 'team-a'),
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })

  await boundary.clear()

  assert.deepEqual(events, ['cancel', 'clear'])
})

test('same-tenant different user clears before applying the replacement identity', async () => {
  let currentMe = me('org-a', 'project-a', 'team-a', 'user-a')
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => {
      events.push('cancel')
      events.push('clear')
    },
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      currentMe = payload.me
      events.push(`apply:${payload.me.user.id}`)
    },
    beforeApply: boundary.beforeApply,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => assert.fail('refresh is not part of login replacement'),
  })

  await coordinator.run(async () => ({
    me: me('org-a', 'project-a', 'team-a', 'user-b'),
    token: 'user-b-token',
  }))

  assert.deepEqual(events, ['cancel', 'clear', 'apply:user-b'])
})
