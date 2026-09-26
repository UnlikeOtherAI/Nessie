import { z } from 'zod'

import type { MemberRosterPermissions, TeamMemberRecord } from './uoa-roster.js'

/**
 * The people read model, `GET /api/people[?team=<id>]`: the organisation's
 * roster with each person's teams and role, or one team's roster.
 *
 * Two sources answer it, and the page says which (`source`), because what a
 * person can then do differs: on an organisation bound to the sign-in provider
 * the roster is the provider's, relayed per request and never stored, and
 * people are named by their provider subject; on an install with no provider
 * it is the install's own rows, named by local user id.
 */

export const PEOPLE_STATUSES = ['ACTIVE', 'DEACTIVATED'] as const
export type PeopleStatus = (typeof PEOPLE_STATUSES)[number]

export const PeopleQuerySchema = z.object({
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(PEOPLE_STATUSES).optional(),
  /** A local team id: the roster narrows to that team, and roles are that team's. */
  team: z.string().uuid().optional(),
})
export type PeopleQuery = z.infer<typeof PeopleQuerySchema>

/** One team a person is in, as the organisation's roster lists it. */
export type PersonTeam = {
  /** The local team id — what `/admin/teams/:teamId` and `?scope=team:<id>` name. */
  id: string
  name: string
  /** Their role in that team. */
  role?: string
}

/** A provider roster row, with the teams the caller may see them in. */
export type ProviderPerson = TeamMemberRecord & {
  /** Present on the organisation's roster; a team's roster carries `teamRole` instead. */
  teams?: PersonTeam[]
}

/** A local roster row: the install is the authority for its own people. */
export type LocalPerson = {
  avatarAttachmentId?: string
  avatarUrl?: string
  displayName: string
  email: string
  /** Their organisation role: owner, admin, member or viewer. */
  orgRole: string
  status: PeopleStatus
  /** Present on a team's roster: their role in that team. */
  teamRole?: string
  teams: PersonTeam[]
  userId: string
}

/**
 * What the local roster lets the caller do. Every local membership write is the
 * owner's (`requireOwner` on each route), so an administrator reads the same
 * roster with these off and the screen says who can.
 */
export type LocalRosterPermissions = {
  addMember: boolean
  addToTeam: boolean
  changeActivation: boolean
  changeRole: boolean
}

/** The team a team-scoped roster is, named so the screen never guesses. */
export type PeopleRosterTeam = { id: string; name: string }

export type PeopleRosterPage =
  | {
      items: ProviderPerson[]
      permissions: MemberRosterPermissions
      source: 'provider'
      team?: PeopleRosterTeam
    }
  | {
      items: LocalPerson[]
      permissions: LocalRosterPermissions
      source: 'local'
      team?: PeopleRosterTeam
    }
