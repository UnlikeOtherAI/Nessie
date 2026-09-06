import type { PrismaClient, User } from '@prisma/client'

import type { SessionTokenClaims } from '../auth/session.js'
import type { createSessionIssuers } from './session-issuers.js'

/**
 * Switching the organisation / project / team a session acts in.
 *
 * This is a capability grant: it mints a new access token whose `org`, `proj`,
 * `team` and `roles` claims are what every downstream guard reads. The whole
 * decision — four membership lookups, the UOA re-authentication rule, and the
 * mint itself — was inlined in `POST /api/auth/switch-context` (2026-09-05
 * review, F1-5), so the route both owned the workflow and was the only place
 * the rule could be read. It lives here instead; the route parses, calls, and
 * translates.
 */

export const ACTOR_CONTEXT_SWITCH_ERROR_CODES = [
  'ACCOUNT_DEACTIVATED',
  'NOT_A_MEMBER',
  'SSO_TEAM_REAUTH_REQUIRED',
  'TEAM_NOT_UOA_LINKED',
  'USER_NOT_FOUND',
] as const

export type ActorContextSwitchErrorCode =
  (typeof ACTOR_CONTEXT_SWITCH_ERROR_CODES)[number]

/**
 * A refusal with a code the route maps to a status, rather than a bare
 * `Error` whose message doubles as the code — rewording the sentence shown to
 * a person must not silently turn a handled 403 into a 500 (2026-09-05
 * review, S2-F4).
 */
export class ActorContextSwitchError extends Error {
  constructor(
    readonly code: ActorContextSwitchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ActorContextSwitchError'
  }
}

type BuildSessionForUser = ReturnType<typeof createSessionIssuers>['buildSessionForUser']

export type ActorContextSwitchResult = {
  session: Awaited<ReturnType<BuildSessionForUser>>
  user: User
}

export const switchActorContext = async (
  prisma: PrismaClient,
  input: {
    buildSessionForUser: BuildSessionForUser
    /** Claims of the session presenting the request, already verified. */
    currentClaims: SessionTokenClaims
    organizationId: string
    projectId: string
    teamId: string
    userId: string
  },
): Promise<ActorContextSwitchResult> => {
  const { currentClaims, organizationId, projectId, teamId, userId } = input

  const orgMember = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
  if (!orgMember) {
    throw new ActorContextSwitchError(
      'NOT_A_MEMBER',
      'Not a member of this organization',
    )
  }
  if (orgMember.deactivatedAt) {
    throw new ActorContextSwitchError(
      'ACCOUNT_DEACTIVATED',
      'Your access to this organisation has been deactivated',
    )
  }

  const [project, projectMember, team, teamMember] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } }),
    prisma.team.findUnique({ where: { id: teamId } }),
    prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } }),
  ])
  if (
    !project
    || project.organizationId !== organizationId
    || !projectMember
    || !team
    || team.projectId !== projectId
    || !teamMember
  ) {
    throw new ActorContextSwitchError(
      'NOT_A_MEMBER',
      'Not a member of this project/team',
    )
  }

  // UnlikeOtherAI owns membership for a UOA session, so the local rows above
  // are not enough: the session may only land on the team its UOA credential
  // was actually issued for. Anything else needs a fresh sign-in, not a
  // locally minted token.
  if (currentClaims.providerType === 'uoa') {
    // A team with no UOA identity at all is a different failure, and telling
    // somebody to sign in again for it sends them through SSO to land back
    // here: there is nothing on the other side to authenticate them into.
    // These rows predate the guard that now refuses to create a local team
    // inside a UOA-bound organisation (`UoaBoundOrganizationError`), so the
    // remedy is to give the team a UOA identity, never to mint a local session
    // for it — that would be exactly the parallel identity path UOA ownership
    // exists to prevent.
    if (!team.externalOrgId || !team.externalTeamId) {
      throw new ActorContextSwitchError(
        'TEAM_NOT_UOA_LINKED',
        'This team is not linked to UnlikeOtherAI, so it cannot be opened. '
        + 'An administrator has to recreate it through UnlikeOtherAI.',
      )
    }

    if (
      !currentClaims.uoaIdentity
      || team.externalOrgId !== currentClaims.uoaIdentity.organizationId
      || team.externalTeamId !== currentClaims.uoaIdentity.teamId
    ) {
      throw new ActorContextSwitchError(
        'SSO_TEAM_REAUTH_REQUIRED',
        'Sign in with UnlikeOtherAI to switch to this team.',
      )
    }
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    throw new ActorContextSwitchError('USER_NOT_FOUND', 'User not found')
  }

  const session = await input.buildSessionForUser({
    organizationId,
    projectId,
    providerId: currentClaims.providerId,
    providerType: currentClaims.providerType,
    roles: [orgMember.role],
    // A UOA session keeps its sid: the switch stays inside one signed-in
    // session, and its refresh family is keyed by that sid.
    sessionId: currentClaims.providerType === 'uoa' ? currentClaims.sid : undefined,
    teamId,
    uoaIdentity: currentClaims.uoaIdentity,
    userId,
  })

  return { session, user }
}
