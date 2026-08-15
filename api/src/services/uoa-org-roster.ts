import type { PrismaClient } from '@prisma/client'
import {
  safeFetch,
  type PinnedFetch,
  type ResolveHost,
} from '@nessie/runtime'
import type {
  CreateWorkspaceInvitationsRequest,
  WorkspaceInvitationRecord,
  WorkspaceInviteResult,
  WorkspaceMemberRecord,
} from '@nessie/schemas'

import { clientHash, isUoaConfigured, loadUoaSettings, type UoaSettings } from './uoa-auth.js'

/**
 * Workspace rosters and invitations, read and written on UnlikeOtherAI's `/org/*`
 * API. UOA owns human identity, membership and invitations; Nessie stores none
 * of it, so every call here is a live relay and every record is display-only.
 *
 * **Backend mode.** These routes are dual-mode: with an `X-UOA-Access-Token`
 * they act as the end user, and Nessie deliberately never holds a spendable
 * user access token (only a bound refresh credential). Omitting that header
 * entirely selects backend mode, authenticated by the domain-hash bearer plus
 * the signed config JWT, which must carry
 * `org_features.backend_org_management: true` (`services/uoa-auth.ts`). The
 * header must be *absent*, never blank — UOA treats an empty credential as
 * malformed and answers `401 MISSING_ACCESS_TOKEN`.
 *
 * **There is no acting user in backend mode**, so UOA applies no owner/admin
 * check of its own and records `actor_user_id: null` with
 * `uoa_actor: { via: "domain_backend" }`. The owner/admin gate in
 * `routes/workspace-members.ts` is therefore the only thing standing between an
 * ordinary member and a whole-workspace mutation — exactly as with the
 * workspace avatar relay.
 *
 * Contract verified 2026-08-15 against https://authentication.unlikeotherai.com/llm
 * §4.6b/§4.7/§4.7a/§4.7b and the machine-readable `/api` endpoint list.
 */

const ROSTER_TIMEOUT_MS = 10_000

/** The upstream could not be consulted, or answered with something unusable. */
export class UoaRosterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaRosterUnavailableError'
  }
}

/** UOA refused the request (4xx). The caller's problem, not an outage. */
export class UoaRosterRejectedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'UoaRosterRejectedError'
  }
}

export type UoaRosterDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
}

/** The UOA org + team ids behind a Nessie team. Both are needed for `/org/*`. */
export type UoaRosterWorkspace = {
  externalOrgId: string
  externalTeamId: string
}

export type UoaRosterPrisma = Pick<PrismaClient, 'team'>

export type WorkspaceMemberActivation = 'deactivate' | 'reactivate'

export type WorkspaceInvitationReview = 'approve' | 'deny'

/** Configured UOA settings, or null when this deployment cannot call UOA at all. */
const rosterSettings = (): UoaSettings | null => {
  if (!isUoaConfigured()) return null
  const settings = loadUoaSettings()
  return settings.clientSecret ? settings : null
}

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

const orgPath = (workspace: UoaRosterWorkspace): string =>
  `/org/organisations/${encodeURIComponent(workspace.externalOrgId)}`

const teamPath = (workspace: UoaRosterWorkspace): string =>
  `${orgPath(workspace)}/teams/${encodeURIComponent(workspace.externalTeamId)}`

const rosterUrl = (
  settings: UoaSettings,
  path: string,
  query: Record<string, string> = {},
): URL => {
  const url = new URL(`${settings.baseUrl}${path}`)
  url.searchParams.set('domain', settings.domain)
  url.searchParams.set('config_url', settings.configUrl)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  return url
}

const fetchOptions = (deps: UoaRosterDeps) => ({
  ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
  maxRedirects: 0,
})

/**
 * One backend-mode `/org/*` call. Note what is *not* here: no
 * `X-UOA-Access-Token` header in any form. Returns the raw parsed body; every
 * caller narrows it itself rather than trusting the shape.
 */
const rosterRequest = async (
  settings: UoaSettings,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; query?: Record<string, string> },
  deps: UoaRosterDeps,
): Promise<unknown> => {
  let response: Response
  try {
    response = await safeFetch(
      rosterUrl(settings, path, init.query),
      {
        method: init.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${clientHash(settings)}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
      },
      fetchOptions(deps),
    )
  } catch {
    throw new UoaRosterUnavailableError('[uoa] the org API is temporarily unavailable')
  }

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new UoaRosterRejectedError(
        `[uoa] the org API refused the request (${response.status})`,
        response.status,
      )
    }
    throw new UoaRosterUnavailableError(`[uoa] the org API returned ${response.status}`)
  }

  const text = await response.text()
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new UoaRosterUnavailableError('[uoa] the org API returned a malformed body')
  }
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

const requireSettings = (): UoaSettings => {
  const settings = rosterSettings()
  if (!settings) {
    throw new UoaRosterUnavailableError('[uoa] this deployment has no UnlikeOtherAI credentials')
  }
  return settings
}

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
 * Approve or deny an invitation a plain member raised while the organisation
 * requires admin approval. Deny is UOA's only "make this invitation stop" verb:
 * there is no cancel or delete for an invitation that was already sent.
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
