import assert from 'node:assert/strict'
import test from 'node:test'

import type { MeResponse } from '@nessie/schemas'
import {
  AuthSessionApiError,
  createSessionMutationCoordinator,
  type SessionPayload,
} from '@nessie/client-core'
import { recoverTeamSwitchFailure } from '../src/layouts/admin-shell/team-switch-recovery.js'
import type { Team } from '../src/lib/teams.js'
import { createSessionQueryBoundary } from '../src/providers/auth-session-query-reset.js'

const source: Team = {
  active: true, label: 'Alpha', organizationId: 'org-a', projectId: '',
  teamId: 'team-a', uoaTeam: true,
}
const target: Team = {
  active: false, label: 'Beta', organizationId: 'org-b', projectId: '',
  teamId: 'team-b', uoaTeam: true,
}

const payload = (active: Team): SessionPayload => ({
  me: {
    auth: { providerId: 'uoa', providerType: 'uoa', autoRedirectToSso: false },
    context: {
      bootstrapMode: false,
      organizationId: 'local-org',
      projectId: 'local-project',
      teamId: `local-${active.teamId}`,
    },
    user: { id: 'user-a' },
    uoaTeams: [source, target].map((team) => ({
      active: team.teamId === active.teamId,
      label: team.label,
      organizationId: team.organizationId,
      teamId: team.teamId,
    })),
  } as unknown as MeResponse,
  token: `token-${active.teamId}`,
})

test('lost switch response reconciles the committed target as success', async () => {
  let currentMe = payload(source).me
  const events: string[] = []
  const boundary = createSessionQueryBoundary({
    readCurrentMe: () => currentMe,
    resetTenantQueries: async () => events.push('cancel', 'clear'),
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
  const result = await recoverTeamSwitchFailure({
    currentTeam: source,
    error: new TypeError('response body was lost'),
    reconcileSession: coordinator.reconcile,
    targetTeam: target,
  })
  assert.deepEqual(result, { outcome: 'switched' })
  assert.deepEqual(events, ['cancel', 'clear', 'apply'])
})

test('ambiguous conflict reports the team returned by reconciliation', async () => {
  const result = await recoverTeamSwitchFailure({
    currentTeam: source,
    error: new AuthSessionApiError('conflict', 'TEAM_SWITCH_CONFLICT', 409),
    reconcileSession: async () => payload(source),
    targetTeam: target,
  })
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') assert.match(result.message, /still in Alpha/)
})

test('unavailable target refreshes the directory and reports the current team', async () => {
  let calls = 0
  const result = await recoverTeamSwitchFailure({
    currentTeam: target,
    error: new AuthSessionApiError('revoked', 'TEAM_NOT_AVAILABLE', 403),
    reconcileSession: async () => {
      calls += 1
      return payload(source)
    },
    targetTeam: target,
  })
  assert.equal(calls, 1)
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /still in Alpha/)
    assert.doesNotMatch(result.message, /still in Beta/)
  }
})

test('failed reconciliation never claims that the source was retained', async () => {
  const result = await recoverTeamSwitchFailure({
    currentTeam: source,
    error: new TypeError('network failed'),
    reconcileSession: async () => { throw new TypeError('still offline') },
    targetTeam: target,
  })
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.match(result.message, /Couldn’t confirm whether the switch to Beta completed/)
    assert.doesNotMatch(result.message, /still in Alpha/)
  }
})

test('all proof-gap codes reauthorize before reconciliation', async () => {
  for (const code of [
    'INTERACTION_REQUIRED',
    'INVALID_REFRESH_TOKEN',
    'NO_REFRESH_TOKEN',
    'TEAM_SWITCH_REAUTH_REQUIRED',
  ]) {
    let calls = 0
    const result = await recoverTeamSwitchFailure({
      currentTeam: source,
      error: new AuthSessionApiError('renew proof', code, 401),
      reconcileSession: async () => {
        calls += 1
        return payload(source)
      },
      targetTeam: target,
    })
    assert.deepEqual(result, { outcome: 'reauthorize' }, code)
    assert.equal(calls, 0, code)
  }
})
