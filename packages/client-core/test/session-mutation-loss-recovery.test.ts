import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SessionMutationLoss,
  classifyWorkspaceSessionPayload,
  sessionMatchesExpectedWorkspace,
  type ExpectedWorkspaceTarget,
  type SessionPayload,
  type WorkspaceSessionSource,
} from '../src/auth-session.js'
import { createSessionMutationCoordinator } from '../src/session-mutation-coordinator.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

const TARGET: ExpectedWorkspaceTarget = {
  organizationId: 'external-org',
  teamId: 'external-team',
}

const exactTargetGuard = (payload: SessionPayload) =>
  sessionMatchesExpectedWorkspace(payload, TARGET)
    ? ({ kind: 'target' } as const)
    : ({ kind: 'foreign', message: 'The renewed session missed the requested workspace.' } as const)

test('a same-team different-person refresh winner is foreign, never the target', async () => {
  // Regression: the one refresh winner after an opaque SessionMutationLoss
  // passes the SAME three-way classification as the direct payload — a
  // winner that claims the exact requested UOA org/team but belongs to
  // another local user must fence, never apply.
  const source: WorkspaceSessionSource = {
    userId: 'user-1',
    organizationId: 'local-org-a',
    projectId: 'local-project-a',
    teamId: 'local-team-a',
    providerId: 'uoa',
  }
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    refresh: async () => {
      refreshCalls += 1
      return {
        me: {
          auth: { providerId: 'uoa' },
          context: {
            organizationId: 'local-org-b',
            projectId: 'local-project-b',
            teamId: 'local-team-b',
          },
          uoaWorkspaces: [
            { active: true, organizationId: TARGET.organizationId, teamId: TARGET.teamId },
          ],
          user: { id: 'user-2' },
        },
        token: 'foreign-winner',
      } as unknown as SessionPayload
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        throw new SessionMutationLoss('The session response body could not be read.')
      },
      (payload) => classifyWorkspaceSessionPayload(payload, TARGET, source),
    ),
    /did not land on the requested workspace/,
  )
  assert.equal(refreshCalls, 1)
  assert.deepEqual(events, ['revoke:foreign-winner', 'clear'])
})

test('an opaque loss whose refresh is an explicit 401 clears once without fencing', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    onTerminal: () => events.push('terminal'),
    refresh: async () => {
      refreshCalls += 1
      return null
    },
  })

  const loss = new SessionMutationLoss('The session response was lost in transit.')
  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        throw loss
      },
      exactTargetGuard,
    ),
    // The ORIGINAL SessionMutationLoss rethrown — the picker surfaces the
    // real failure, not a synthetic refresh error.
    (error: unknown) => error === loss,
  )
  // The refresh 401 is an explicit rejection, not transient: exactly one
  // clear so stale local auth cannot remain — but never terminal (no
  // onTerminal, no fence, no foreign revocation), and the coordinator lives
  // on for a later explicit mutation.
  assert.equal(refreshCalls, 1)
  assert.deepEqual(events, ['clear'])

  const after = await coordinator.run(async () => sessionPayload('token-after'))
  assert.equal(after.token, 'token-after')
  assert.deepEqual(events, ['clear', 'apply:token-after'])
})
