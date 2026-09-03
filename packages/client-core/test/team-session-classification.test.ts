import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureTeamSessionSource,
  classifyTeamSessionPayload,
  type ExpectedTeamTarget,
  type SessionPayload,
  type TeamSessionSource,
} from '../src/auth-session.js'

const TARGET: ExpectedTeamTarget = {
  organizationId: 'external-org-b',
  teamId: 'external-team-b',
}

const SOURCE: TeamSessionSource = {
  userId: 'user-1',
  organizationId: 'local-org-a',
  projectId: 'local-project-a',
  teamId: 'local-team-a',
  providerId: 'uoa',
}

const teamPayload = (overrides: {
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
    uoaTeams: [
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
  // The happy path: same person, same provider, exact requested team.
  assert.equal(classifyTeamSessionPayload(teamPayload({}), TARGET, SOURCE).kind, 'target')
})

test('a same-team different-person payload is foreign, never the target', () => {
  // The payload claims EXACTLY the requested active UOA org/team but belongs
  // to another local user: foreign, never target, never source.
  const outcome = classifyTeamSessionPayload(
    teamPayload({ userId: 'user-2' }),
    TARGET,
    SOURCE,
  )
  assert.equal(outcome.kind, 'foreign')
})

test('a non-UOA provider payload on the requested team is foreign', () => {
  const outcome = classifyTeamSessionPayload(
    teamPayload({ providerId: 'email' }),
    TARGET,
    SOURCE,
  )
  assert.equal(outcome.kind, 'foreign')
})

test('the exact preserved source session classifies as source', () => {
  const outcome = classifyTeamSessionPayload(
    teamPayload({
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

test('captureTeamSessionSource only captures UOA sessions', () => {
  const me = {
    auth: { providerId: 'uoa' },
    context: {
      organizationId: 'local-org-a',
      projectId: 'local-project-a',
      teamId: 'local-team-a',
    },
    user: { id: 'user-1' },
  } as unknown as SessionPayload['me']
  assert.deepEqual(captureTeamSessionSource(me), SOURCE)

  const emailMe = {
    ...me,
    auth: { providerId: 'email' },
  } as unknown as SessionPayload['me']
  assert.equal(captureTeamSessionSource(emailMe), null)
})
