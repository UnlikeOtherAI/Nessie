import type {
  CreateMemberInvitationRequest,
  MemberRosterPermissions,
  TeamMemberCandidate,
  TeamInvitationRecord,
  TeamMemberRecord,
} from '@nessie/schemas'

import {
  requireSettings,
  rosterRequest,
  teamPath,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from './uoa-org-request.js'
import {
  parseTeamRosterMembers,
  parseUoaInvitations,
  parseUoaPaginationMeta,
  parseUoaRosterPermissions,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from './uoa-org-roster.js'

const queryValues = (
  query: UoaRosterListQuery,
  keys: (keyof UoaRosterListQuery)[],
): Record<string, string> =>
  Object.fromEntries(keys.flatMap((key) => {
    const value = query[key]
    if (value === undefined) return []
    return [[key, String(value)]]
  }))

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** A paged team roster from UOA; identity stays UOA-owned and live. */
export const listTeamMembers = async (
  team: UoaRosterTeam,
  query: UoaRosterListQuery = {},
  deps: UoaRosterDeps = {},
): Promise<UoaRosterPage<TeamMemberRecord, MemberRosterPermissions>> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/members`,
    { method: 'GET', query: queryValues(query, ['status', 'limit', 'cursor', 'direction']) },
    deps,
  )
  return {
    items: parseTeamRosterMembers(payload),
    meta: parseUoaPaginationMeta(payload),
    permissions: parseUoaRosterPermissions(payload),
  }
}

/** Bounded, exact-team search of active organisation members not already on it. */
export const findTeamMemberCandidates = async (
  team: UoaRosterTeam,
  query: Pick<UoaRosterListQuery, 'cursor' | 'direction' | 'limit'> & { q: string },
  deps: UoaRosterDeps = {},
): Promise<UoaRosterPage<TeamMemberCandidate, Pick<MemberRosterPermissions, 'addMember' | 'searchMemberCandidates'>>> => {
  const { q, ...page } = query
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/members/candidates`,
    {
      method: 'GET',
      query: { q, ...queryValues(page, ['limit', 'cursor', 'direction']) },
    },
    deps,
  )
  const body = asRecord(payload)
  const rows = Array.isArray(body?.data) ? body.data : []
  const permissions = parseUoaRosterPermissions(payload)
  return {
    items: rows.flatMap((value) => {
      const row = asRecord(value)
      const identity = asRecord(row?.identity)
      const uoaSub = text(row?.subject) ?? text(row?.userId)
      if (!uoaSub) return []
      return [{
        uoaSub,
        ...(text(identity?.displayName) ? { displayName: text(identity?.displayName) } : {}),
        ...(text(identity?.email) ? { email: text(identity?.email) } : {}),
        ...(text(row?.avatarImageUrl) ?? text(identity?.avatarImageUrl)
          ? { avatarImageUrl: text(row?.avatarImageUrl) ?? text(identity?.avatarImageUrl) }
          : {}),
        ...(text(row?.orgRole) ? { orgRole: text(row?.orgRole) } : {}),
      }]
    }),
    meta: parseUoaPaginationMeta(payload),
    permissions: {
      addMember: permissions.addMember,
      searchMemberCandidates: permissions.searchMemberCandidates ?? false,
    },
  }
}

/** Add a selected UOA organisation member to this exact team. */
export const addTeamMember = async (
  team: UoaRosterTeam,
  input: { uoaSub: string; teamRole?: string },
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/members`,
    { method: 'POST', body: { user_id: input.uoaSub, ...(input.teamRole ? { team_role: input.teamRole } : {}) } },
    deps,
  )
}

/** UOA's actionable pending feed, distinct from its owner-only approval queue. */
export const listTeamInvitations = async (
  team: UoaRosterTeam,
  query: Pick<UoaRosterListQuery, 'cursor' | 'direction' | 'limit'> = {},
  deps: UoaRosterDeps = {},
): Promise<UoaRosterPage<TeamInvitationRecord, Pick<MemberRosterPermissions, 'addMember'> & { viewPendingInvitations: boolean }>> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/member-invitations`,
    { method: 'GET', query: queryValues(query, ['limit', 'cursor', 'direction']) },
    deps,
  )
  const permissions = asRecord(asRecord(payload)?.permissions)
  return {
    items: parseUoaInvitations(payload),
    meta: parseUoaPaginationMeta(payload),
    permissions: {
      addMember: permissions?.createInvitation === true,
      viewPendingInvitations: permissions?.viewPendingInvitations === true,
    },
  }
}

/** Send one exact-team invitation in UOA's user-mode contract. */
export const createTeamInvitation = async (
  team: UoaRosterTeam,
  input: CreateMemberInvitationRequest,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${teamPath(team)}/invitations`,
    { method: 'POST', body: input },
    deps,
  )
}
