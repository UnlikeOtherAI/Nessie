import type { CreateTeamInvitationsRequest, TeamInviteResult } from '@nessie/schemas'

import {
  orgPath,
  requireSettings,
  rosterRequest,
  teamPath,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from './uoa-org-request.js'
import {
  UoaInvitationAlreadyAcceptedError,
  UoaInvitationOrgConflictError,
  type TeamInvitationReview,
} from './uoa-org-roster.js'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Legacy backend bulk invite contract. New UI uses `createTeamInvitation`. */
export const createTeamInvitations = async (
  team: UoaRosterTeam,
  input: CreateTeamInvitationsRequest,
  deps: UoaRosterDeps = {},
): Promise<TeamInviteResult[]> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/invitations`,
    {
      method: 'POST',
      body: {
        invites: input.invites.map((invite) => ({
          email: invite.email,
          ...(invite.name ? { name: invite.name } : {}),
          ...(invite.teamRole ? { teamRole: invite.teamRole } : {}),
        })),
      },
    },
    deps,
  )
  const resultRows = asRecord(payload)?.results
  const rows: unknown[] = Array.isArray(resultRows) ? resultRows : []
  return rows.flatMap((value) => {
    const row = asRecord(value)
    if (!row) return []
    return [{
      ...(text(row.email) ? { email: text(row.email) } : {}),
      ...(text(row.status) ? { status: text(row.status) } : {}),
    }]
  })
}

export const resendTeamInvitation = async (
  team: UoaRosterTeam,
  inviteId: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/invitations/${encodeURIComponent(inviteId)}/resend`,
    { method: 'POST' },
    deps,
  )
}

export const revokeTeamInvitation = async (
  team: UoaRosterTeam,
  inviteId: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  let payload: unknown
  try {
    payload = await rosterRequest(
      requireSettings(),
      `${teamPath(team)}/invitations/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' },
      deps,
    )
  } catch (error) {
    if (error instanceof UoaRosterRejectedError && error.statusCode === 409) {
      throw new UoaInvitationAlreadyAcceptedError()
    }
    throw error
  }
  if (payload === null) return
  if (asRecord(payload)?.ok !== true) {
    throw new UoaRosterUnavailableError('[uoa] the org API returned an unusable revoke result')
  }
}

export const acceptTeamInvitation = async (
  team: UoaRosterTeam,
  inviteId: string,
  uoaSub: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  let payload: unknown
  try {
    payload = await rosterRequest(
      requireSettings(),
      `${teamPath(team)}/invitations/${encodeURIComponent(inviteId)}/accept`,
      { method: 'POST', body: { userId: uoaSub } },
      deps,
    )
  } catch (error) {
    if (error instanceof UoaRosterRejectedError && error.statusCode === 400 && error.upstreamCode === 'ORG_CONFLICT_ON_DOMAIN') {
      throw new UoaInvitationOrgConflictError()
    }
    throw error
  }
  const body = asRecord(payload)
  if (!body || body.ok !== true || body.orgId !== team.externalOrgId || body.teamId !== team.externalTeamId) {
    throw new UoaRosterUnavailableError('[uoa] the org API returned an unusable acceptance result')
  }
}

export const reviewTeamInvitation = async (
  team: UoaRosterTeam,
  inviteId: string,
  action: TeamInvitationReview,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${orgPath(team)}/invitations/${encodeURIComponent(inviteId)}/${action}`,
    { method: 'POST' },
    deps,
  )
}
