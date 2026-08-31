import type { PrismaClient } from '@prisma/client'
import type {
  CreateWorkspaceInvitationsRequest,
  WorkspaceInvitationRecord,
  WorkspaceInviteResult,
  WorkspaceMemberRecord,
} from '@nessie/schemas'

import {
  orgPath,
  requireSettings,
  rosterRequest,
  rosterSettings,
  teamPath,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
  type UoaRosterWorkspace,
} from './uoa-org-request.js'

export {
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
  type UoaRosterWorkspace,
} from './uoa-org-request.js'

/**
 * Workspace rosters and invitations, read and written on UnlikeOtherAI's `/org/*`
 * API. UOA owns human identity, membership and invitations; Nessie stores none
 * of it, so every call here is a live relay and every record is display-only.
 *
 * Lives in `@nessie/workspace-admin` (re-exported by
 * `api/src/services/uoa-org-roster.ts`) because the personal assistant's
 * `people_search` answers "who is X" from the same roster the Members page
 * shows, and the worker cannot import `api/src/services/*`.
 *
 * **Backend mode.** These routes are dual-mode: with an `X-UOA-Access-Token`
 * they act as the end user, and Nessie deliberately never holds a spendable
 * user access token (only a bound refresh credential). Omitting that header
 * entirely selects backend mode, authenticated by the domain-hash bearer plus
 * the signed config JWT, which must carry
 * `org_features.backend_org_management: true` (`api/src/services/uoa-auth.ts`). The
 * header must be *absent*, never blank — UOA treats an empty credential as
 * malformed and answers `401 MISSING_ACCESS_TOKEN`.
 *
 * **There is no acting user in backend mode**, so UOA applies no owner/admin
 * check of its own and records `actor_user_id: null` with
 * `uoa_actor: { via: "domain_backend" }`. The owner/admin gate in
 * `api/src/routes/workspace-members.ts` is therefore the only thing standing between an
 * ordinary member and a whole-workspace mutation — exactly as with the
 * workspace avatar relay.
 *
 * Contract verified 2026-08-15 against https://authentication.unlikeotherai.com/llm
 * §4.6b/§4.7/§4.7a/§4.7b and the machine-readable `/api` endpoint list.
 */

/** The invitee already belongs to another UOA org on this product domain. */
export class UoaInvitationOrgConflictError extends Error {
  constructor() {
    super('[uoa] the invitee already belongs to another organisation on this domain')
    this.name = 'UoaInvitationOrgConflictError'
  }
}

/**
 * The invitation was already accepted, so there is nothing left to revoke — the
 * person is a member and removal is the operation that applies. Distinct from
 * `UoaRosterRejectedError` because "too late" is a different answer from "that
 * invitation does not exist", and the route says so.
 */
export class UoaInvitationAlreadyAcceptedError extends Error {
  constructor() {
    super('[uoa] this invitation has already been accepted')
    this.name = 'UoaInvitationAlreadyAcceptedError'
  }
}

export type UoaRosterPrisma = Pick<PrismaClient, 'team'>

export type WorkspaceMemberActivation = 'deactivate' | 'reactivate'

export type WorkspaceInvitationReview = 'approve' | 'deny'

/**
 * Resolve the UOA workspace behind the actor's own session team. A team with no
 * UOA mapping — or a deployment with no UOA at all — resolves to null, and the
 * caller answers 404: there is no local roster to fall back to.
 */
export const resolveUoaRosterWorkspace = async (
  prisma: UoaRosterPrisma,
  input: { organizationId: string; teamId: string | null | undefined },
): Promise<UoaRosterWorkspace | null> => {
  if (!input.teamId || !rosterSettings()) return null
  const team = await prisma.team.findFirst({
    where: { id: input.teamId, project: { organizationId: input.organizationId } },
    select: { externalOrgId: true, externalWorkspaceId: true },
  })
  return team?.externalOrgId && team.externalWorkspaceId
    ? { externalOrgId: team.externalOrgId, externalTeamId: team.externalWorkspaceId }
    : null
}

const trimString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Rows out of a `{ data: [...] }` / `{ members: [...] }` envelope, or nothing. */
const rowsAt = (payload: unknown, key: string): Record<string, unknown>[] => {
  const envelope = asRecord(payload)
  const rows = envelope ? envelope[key] : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const record = asRecord(row)
    return record ? [record] : []
  })
}

const optional = (
  entries: [string, string | undefined][],
): Record<string, string> =>
  Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== undefined))

/**
 * Team membership rows (`{ userId, teamRole }`). They carry no email or name —
 * UOA keeps identity on the organisation membership — so the roster is the join
 * of these two reads on the UOA subject.
 */
const parseTeamMembers = (payload: unknown): Map<string, string | undefined> => {
  const members = new Map<string, string | undefined>()
  for (const row of rowsAt(payload, 'members')) {
    const uoaSub = trimString(row.userId)
    if (uoaSub) members.set(uoaSub, trimString(row.teamRole))
  }
  return members
}

const parseOrgMembers = (payload: unknown): Map<string, WorkspaceMemberRecord> => {
  const members = new Map<string, WorkspaceMemberRecord>()
  for (const row of rowsAt(payload, 'data')) {
    const uoaSub = trimString(row.userId)
    if (!uoaSub) continue
    members.set(uoaSub, {
      uoaSub,
      ...optional([
        ['displayName', trimString(row.name) ?? trimString(row.displayName)],
        ['email', trimString(row.email)],
        ['orgRole', trimString(row.role)],
        ['status', trimString(row.status)],
      ]),
    })
  }
  return members
}

const parseInvitations = (payload: unknown, key: string): WorkspaceInvitationRecord[] =>
  rowsAt(payload, key).flatMap((row) => {
    const inviteId = trimString(row.inviteId) ?? trimString(row.id)
    if (!inviteId) return []
    return [{
      inviteId,
      ...optional([
        ['email', trimString(row.email)],
        ['name', trimString(row.inviteName) ?? trimString(row.name)],
        ['teamRole', trimString(row.teamRole)],
        ['status', trimString(row.status)],
        ['approvalStatus', trimString(row.approvalStatus)],
        ['invitedByName', trimString(row.invitedByName)],
        ['lastSentAt', trimString(row.lastSentAt)],
        ['expiresAt', trimString(row.expiresAt)],
      ]),
    }]
  })

const parseInviteResults = (payload: unknown): WorkspaceInviteResult[] =>
  rowsAt(payload, 'results').map((row) => ({
    ...optional([
      ['email', trimString(row.email)],
      ['status', trimString(row.status)],
    ]),
  }))

/**
 * The workspace roster: everyone in the UOA team, named from the organisation
 * membership list. Members whose organisation row is not visible still appear
 * with their subject and team role — a roster that silently drops people would
 * be worse than one with a missing name.
 */
export const listWorkspaceMembers = async (
  workspace: UoaRosterWorkspace,
  deps: UoaRosterDeps = {},
): Promise<WorkspaceMemberRecord[]> => {
  const settings = requireSettings()
  const [teamPayload, orgPayload] = await Promise.all([
    rosterRequest(settings, teamPath(workspace), { method: 'GET' }, deps),
    rosterRequest(
      settings,
      `${orgPath(workspace)}/members`,
      { method: 'GET', query: { status: 'all' } },
      deps,
    ),
  ])

  const teamRoles = parseTeamMembers(teamPayload)
  const identities = parseOrgMembers(orgPayload)
  return [...teamRoles.entries()].map(([uoaSub, teamRole]) => ({
    ...(identities.get(uoaSub) ?? { uoaSub }),
    ...(teamRole ? { teamRole } : {}),
  }))
}

/** Change a member's role inside this workspace (UOA team role). */
export const updateWorkspaceMemberRole = async (
  workspace: UoaRosterWorkspace,
  uoaSub: string,
  teamRole: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(workspace)}/members/${encodeURIComponent(uoaSub)}`,
    { method: 'PUT', body: { team_role: teamRole } },
    deps,
  )
}

/** Remove a member from this workspace. UOA soft-removes and revokes their team sessions. */
export const removeWorkspaceMember = async (
  workspace: UoaRosterWorkspace,
  uoaSub: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(workspace)}/members/${encodeURIComponent(uoaSub)}`,
    { method: 'DELETE' },
    deps,
  )
}

/**
 * Suspend or restore a member across the whole UOA organisation. This is
 * organisation-level on purpose: UOA's deactivation is what revokes sessions,
 * and it refuses to deactivate an owner.
 */
export const setWorkspaceMemberActivation = async (
  workspace: UoaRosterWorkspace,
  uoaSub: string,
  action: WorkspaceMemberActivation,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${orgPath(workspace)}/members/${encodeURIComponent(uoaSub)}/${action}`,
    { method: 'POST' },
    deps,
  )
}

/** Invitation history for this workspace (pending, accepted, expired, …). */
export const listWorkspaceInvitations = async (
  workspace: UoaRosterWorkspace,
  deps: UoaRosterDeps = {},
): Promise<WorkspaceInvitationRecord[]> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(workspace)}/invitations`,
    { method: 'GET' },
    deps,
  )
  return parseInvitations(payload, 'data')
}

/**
 * Send invitations. Acceptance is hosted by UOA — Nessie never mints, stores or
 * renders an invitation token.
 */
export const createWorkspaceInvitations = async (
  workspace: UoaRosterWorkspace,
  input: CreateWorkspaceInvitationsRequest,
  deps: UoaRosterDeps = {},
): Promise<WorkspaceInviteResult[]> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(workspace)}/invitations`,
    {
      method: 'POST',
      body: {
        invites: input.invites.map((invite) => ({
          email: invite.email,
          ...optional([['name', invite.name], ['teamRole', invite.teamRole]]),
        })),
      },
    },
    deps,
  )
  return parseInviteResults(payload)
}

/** Resend a pending invitation email; UOA refreshes its 30-day expiry. */
export const resendWorkspaceInvitation = async (
  workspace: UoaRosterWorkspace,
  inviteId: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(workspace)}/invitations/${encodeURIComponent(inviteId)}/resend`,
    { method: 'POST' },
    deps,
  )
}

/**
 * Withdraw an invitation that has already been sent. The link stops working and
 * the row leaves the team's pending list.
 *
 * UOA answers `200 { ok: true }` for a live invitation **and** for one that was
 * already revoked — revoking twice is the same outcome as revoking once, so the
 * second click is a success, not an error. An invitation that has already been
 * accepted is a `409`: the person is a member now, and removing them is a
 * different operation with different consequences, so it is refused in words
 * rather than quietly reinterpreted. An unknown or foreign invite id is a
 * generic `404`, which tells a caller nothing about other workspaces.
 *
 * A 200 body that is not the agreed success shape is treated as an outage:
 * "revoked" is a claim about the upstream's state, and a body we cannot read is
 * no evidence for it.
 */
export const revokeTeamInvitation = async (
  workspace: UoaRosterWorkspace,
  inviteId: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  let payload: unknown
  try {
    payload = await rosterRequest(
      requireSettings(),
      `${teamPath(workspace)}/invitations/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' },
      deps,
    )
  } catch (error) {
    if (error instanceof UoaRosterRejectedError && error.statusCode === 409) {
      throw new UoaInvitationAlreadyAcceptedError()
    }
    throw error
  }

  // An empty 200 is still a success; only a body that contradicts one is not.
  if (payload === null) return
  const body = asRecord(payload)
  if (!body || body.ok !== true) {
    throw new UoaRosterUnavailableError('[uoa] the org API returned an unusable revoke result')
  }
}

/**
 * Accept one invitation for the authenticated UOA subject. This backend-mode
 * relay carries no spendable user token; UOA proves the invitation belongs to
 * `uoaSub` and applies its organisation-domain rules.
 */
export const acceptWorkspaceInvitation = async (
  workspace: UoaRosterWorkspace,
  inviteId: string,
  uoaSub: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  let payload: unknown
  try {
    payload = await rosterRequest(
      requireSettings(),
      `${teamPath(workspace)}/invitations/${encodeURIComponent(inviteId)}/accept`,
      { method: 'POST', body: { userId: uoaSub } },
      deps,
    )
  } catch (error) {
    if (
      error instanceof UoaRosterRejectedError
      && error.statusCode === 400
      && error.upstreamCode === 'ORG_CONFLICT_ON_DOMAIN'
    ) {
      throw new UoaInvitationOrgConflictError()
    }
    throw error
  }

  const body = asRecord(payload)
  if (
    !body
    || body.ok !== true
    || body.orgId !== workspace.externalOrgId
    || body.teamId !== workspace.externalTeamId
  ) {
    throw new UoaRosterUnavailableError('[uoa] the org API returned an unusable acceptance result')
  }
}

/**
 * Approve or deny an invitation a plain member raised while the organisation
 * requires admin approval. Deny is UOA's review verb for an invitation that was
 * never sent; `revokeTeamInvitation` withdraws one that was.
 */
export const reviewWorkspaceInvitation = async (
  workspace: UoaRosterWorkspace,
  inviteId: string,
  action: WorkspaceInvitationReview,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${orgPath(workspace)}/invitations/${encodeURIComponent(inviteId)}/${action}`,
    { method: 'POST' },
    deps,
  )
}
