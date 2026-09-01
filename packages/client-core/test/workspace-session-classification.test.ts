import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureWorkspaceSessionSource,
  classifyWorkspaceSessionPayload,
  type ExpectedWorkspaceTarget,
  type SessionPayload,
  type WorkspaceSessionSource,
} from '../src/auth-session.js'

const TARGET: ExpectedWorkspaceTarget = {
  organizationId: 'external-org-b',
  teamId: 'external-team-b',
}

const SOURCE: WorkspaceSessionSource = {
  userId: 'user-1',
  organizationId: 'local-org-a',
  projectId: 'local-project-a',
  teamId: 'local-team-a',
  providerId: 'uoa',
}

const workspacePayload = (overrides: {
  activeOrganizationId?: string
  activeTeamId?: string
  context?: { organizationId: string; projectId: string; teamId: string }
  providerId?: string
  userId?: string
}): SessionPayload => ({
  me: {
    auth: { providerId: overrides.providerId ?? 'uoa' },
    context: overrides.context ?? {
      organizationId: 'local-org-b',
      projectId: 'local-project-b',
      teamId: 'local-team-b',
    },
    uoaWorkspaces: [
      {
        active: true,
        organizationId: overrides.activeOrganizationId ?? TARGET.organizationId,
        teamId: overrides.activeTeamId ?? TARGET.teamId,
      },
    ],
    user: { id: overrides.userId ?? 'user-1' },
  },
  token: 'payload-token',
} as unknown as SessionPayload)

test('target requires the exact active UOA org/team AND the source user and UOA provider', () => {
  // The happy path: same person, same provider, exact requested workspace.
  assert.equal(classifyWorkspaceSessionPayload(workspacePayload({}), TARGET, SOURCE).kind, 'target')
})

test('a same-team different-person payload is foreign, never the target', () => {
  // The payload claims EXACTLY the requested active UOA org/team but belongs
  // to another local user: foreign, never target, never source.
  const outcome = classifyWorkspaceSessionPayload(
    workspacePayload({ userId: 'user-2' }),
    TARGET,
    SOURCE,
  )
  assert.equal(outcome.kind, 'foreign')
})

test('a non-UOA provider payload on the requested workspace is foreign', () => {
  const outcome = classifyWorkspaceSessionPayload(
    workspacePayload({ providerId: 'email' }),
    TARGET,
    SOURCE,
  )
  assert.equal(outcome.kind, 'foreign')
})

test('the exact preserved source session classifies as source', () => {
  const outcome = classifyWorkspaceSessionPayload(
    workspacePayload({
      activeOrganizationId: 'external-org-a',
      activeTeamId: 'external-team-a',
      context: {
        organizationId: SOURCE.organizationId,
        projectId: SOURCE.projectId,
        teamId: SOURCE.teamId,
      },
    }),
    TARGET,
    SOURCE,
  )
  assert.equal(outcome.kind, 'source')
})

test('captureWorkspaceSessionSource only captures UOA sessions', () => {
  const me = {
    auth: { providerId: 'uoa' },
    context: {
      organizationId: 'local-org-a',
      projectId: 'local-project-a',
      teamId: 'local-team-a',
    },
    user: { id: 'user-1' },
  } as unknown as SessionPayload['me']
  assert.deepEqual(captureWorkspaceSessionSource(me), SOURCE)

  const emailMe = {
    ...me,
    auth: { providerId: 'email' },
  } as unknown as SessionPayload['me']
  assert.equal(captureWorkspaceSessionSource(emailMe), null)
})
