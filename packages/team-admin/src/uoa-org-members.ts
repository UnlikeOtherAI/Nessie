import { createUoaSubjectAssertion } from '@nessie/runtime'
import type {
  MemberInvitationTarget,
  MemberTeamAccess,
  MemberRosterPermissions,
  TeamInvitationRecord,
  UoaSessionIdentity,
  TeamMemberRecord,
} from '@nessie/schemas'
import type { PaginationMeta } from '@nessie/schemas'

import {
  orgPath,
  requireSettings,
  rosterRequest,
  type UoaRosterDeps,
} from './uoa-org-request.js'
import {
  delegatedSettings,
  parseOrgMembers,
  parseUoaInvitations,
  parseUoaPaginationMeta,
  UoaRosterIdentityError,
  type UoaRosterListQuery,
  type UoaRosterPage,
} from './uoa-org-roster.js'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const queryValues = (query: UoaRosterListQuery): Record<string, string> =>
  Object.fromEntries(
    [
      ['status', query.status],
      ['limit', query.limit === undefined ? undefined : String(query.limit)],
      ['cursor', query.cursor],
      ['direction', query.direction],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

type InvitationPermissions = { createInvitation: boolean; viewPendingInvitations: boolean }

export type UoaInvitationTargetPage = {
  items: MemberInvitationTarget[]
  meta: PaginationMeta
  permissions: { createInvitation: boolean }
}

export type UoaInvitationPage = {
  items: TeamInvitationRecord[]
  meta: PaginationMeta
  permissions: InvitationPermissions
}

export type UoaMemberTeamAccess = {
  items: MemberTeamAccess[]
  permissions: { changeTeamAccess: boolean }
}

/**
 * Attach an assertion of the signed-in UOA user to an ORG-scoped roster
 * operation. The exact team, where one is selected, is authorized by UOA's
 * target route — the subject assertion binds the caller only to this org.
 */
export const withUoaOrgRosterSubjectAssertion = (
  orgId: string,
  identity: UoaSessionIdentity | undefined,
  deps: UoaRosterDeps = {},
): UoaRosterDeps => {
  if (!identity || identity.tokenVersion === null || identity.organizationId !== orgId) {
    throw new UoaRosterIdentityError(
      'A current UnlikeOtherAI session for this organisation is required.',
    )
  }
  const settings = delegatedSettings()
  return {
    ...deps,
    subjectAssertion: createUoaSubjectAssertion(
      settings,
      {
        organizationId: identity.organizationId,
        subject: identity.subject,
        teamId: identity.teamId,
        tokenVersion: identity.tokenVersion,
      },
      `${settings.authBaseUrl}/org`,
    ),
  }
}

/**
 * The organisation-wide roster: every member of the UOA organisation, with
 * their ORG role — never scoped to a single team. This is deliberately
 * distinct from `listTeamMembers` (uoa-org-roster.ts), which joins a
 * team's membership with org identity and is correctly team-scoped for the
 * team-members surface. An "Organization Members" page must read this
 * function, not that one — see docs/plans/2026-08-31-identity-belonging-audit.md
 * (the org-vs-team scope confusion class of bug) for why the distinction
 * matters.
 */
export const listOrganisationMembers = async (
  orgId: string,
  query: UoaRosterListQuery = {},
  deps: UoaRosterDeps = {},
): Promise<UoaRosterPage<TeamMemberRecord, MemberRosterPermissions>> => {
  const settings = requireSettings()
  const payload = await rosterRequest(
    settings,
    `${orgPath({ externalOrgId: orgId })}/members`,
    { method: 'GET', query: queryValues(query) },
    deps,
  )
  const permissions = asRecord(asRecord(payload)?.permissions)
  return {
    items: [...parseOrgMembers(payload).values()],
    meta: parseUoaPaginationMeta(payload),
    permissions: {
      addMember: permissions?.addMember === true,
      changeMemberRole: permissions?.changeMemberRole === true,
      removeMember: permissions?.removeMember === true,
      deactivateMember: permissions?.deactivateMember === true,
      reactivateMember: permissions?.reactivateMember === true,
      viewMemberEmail: permissions?.viewMemberEmail === true,
    },
  }
}

/** Explicit invite targets — only teams UOA says this caller may administer. */
export const listMemberInvitationTargets = async (
  orgId: string,
  query: Pick<UoaRosterListQuery, 'cursor' | 'direction' | 'limit'> = {},
  deps: UoaRosterDeps = {},
): Promise<UoaInvitationTargetPage> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${orgPath({ externalOrgId: orgId })}/member-invitation-targets`,
    { method: 'GET', query: queryValues(query) },
    deps,
  )
  const body = asRecord(payload)
  const rows = Array.isArray(body?.data) ? body.data : []
  return {
    items: rows.flatMap((value) => {
      const row = asRecord(value)
      const id = text(row?.id)
      const name = text(row?.name)
      return id && name
        ? [{
            id,
            name,
            ...(text(row?.slug) ? { slug: text(row?.slug) } : {}),
            ...(text(row?.avatarImageUrl) ? { avatarImageUrl: text(row?.avatarImageUrl) } : {}),
          }]
        : []
    }),
    meta: parseUoaPaginationMeta(payload),
    permissions: { createInvitation: asRecord(body?.permissions)?.createInvitation === true },
  }
}

/** The actionable pending invitation feed, never UOA's approval work queue. */
export const listOrganisationMemberInvitations = async (
  orgId: string,
  query: Pick<UoaRosterListQuery, 'cursor' | 'direction' | 'limit'> = {},
  deps: UoaRosterDeps = {},
): Promise<UoaInvitationPage> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${orgPath({ externalOrgId: orgId })}/member-invitations`,
    { method: 'GET', query: queryValues(query) },
    deps,
  )
  const permissions = asRecord(asRecord(payload)?.permissions)
  return {
    items: parseUoaInvitations(payload),
    meta: parseUoaPaginationMeta(payload),
    permissions: {
      createInvitation: permissions?.createInvitation === true,
      viewPendingInvitations: permissions?.viewPendingInvitations === true,
    },
  }
}

/**
 * Live, editable team memberships for one organisation member. Omitted
 * teams are outside this caller's authority.
 */
export const listOrganisationMemberTeamAccess = async (
  orgId: string,
  uoaSub: string,
  deps: UoaRosterDeps = {},
): Promise<UoaMemberTeamAccess> => {
  const payload = await rosterRequest(
    requireSettings(),
    `${orgPath({ externalOrgId: orgId })}/members/${encodeURIComponent(uoaSub)}/teams`,
    { method: 'GET' },
    deps,
  )
  const body = asRecord(payload)
  const rows = Array.isArray(body?.data) ? body.data : []
  return {
    items: rows.flatMap((value) => {
      const row = asRecord(value)
      const id = text(row?.id)
      const name = text(row?.name)
      if (!id || !name || typeof row?.hasAccess !== 'boolean') return []
      return [{
        id,
        name,
        hasAccess: row.hasAccess,
        ...(text(row?.slug) ? { slug: text(row?.slug) } : {}),
        ...(text(row?.avatarImageUrl) ? { avatarImageUrl: text(row?.avatarImageUrl) } : {}),
      }]
    }),
    permissions: {
      changeTeamAccess: asRecord(body?.permissions)?.changeTeamAccess === true,
    },
  }
}

/** Change a member's ORG role (owner | admin | member). */
export const updateOrganisationMemberRole = async (
  orgId: string,
  uoaSub: string,
  role: string,
  deps: UoaRosterDeps = {},
): Promise<void> => {
  await rosterRequest(
    requireSettings(),
    `${orgPath({ externalOrgId: orgId })}/members/${encodeURIComponent(uoaSub)}`,
    { method: 'PUT', body: { role } },
    deps,
  )
}
