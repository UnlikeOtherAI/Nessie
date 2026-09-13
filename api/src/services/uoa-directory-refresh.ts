import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  createUoaSubjectAssertion,
  loadUoaDelegatedIdentitySettings,
  requestUoaOrganization,
  UoaOrgRequestRejectedError,
  UoaOrgRequestUnavailableError,
  type PinnedFetch,
  type ResolveHost,
  type UoaDelegatedIdentitySettings,
} from '@nessie/runtime'

import { syncTeamInviteAlerts } from './team-invite-alerts.js'
import {
  DIRECTORY_FRESH_MS,
  mayAttemptUoaDirectoryRefresh,
  noteUoaDirectoryRefreshAttempt,
  readUoaTeamDirectoryAge,
  rememberUoaTeamDirectory,
  suppressUoaDirectoryRefreshUntilVerifiedRead,
} from './uoa-directory-cache.js'
import {
  parseUoaTeamDirectoryPayload,
  type UoaTeamDirectory,
} from './uoa-team-directory.js'

/**
 * On-demand refresh of the UOA team directory for one signed-in person.
 *
 * `GET /api/auth/me` used to answer purely from the 30-minute cache written at
 * login and at token rotation. Anything that changed at UOA in between — an
 * invitation created for someone already signed in, a membership accepted
 * through a mail link, another admin's change — stayed invisible for the whole
 * TTL, through page reloads included, until a sign-out and sign-in. This module
 * closes that window without turning `/api/auth/me` into a UOA round trip each
 * time: the cached copy is believed for `DIRECTORY_FRESH_MS`, and only an older
 * one triggers a read.
 *
 * Two things bound the upstream traffic, and both are needed. The in-flight map
 * collapses calls that OVERLAP. The attempt cooldown in
 * `uoa-directory-cache.ts` bounds calls that follow one another: a failed read
 * does not refresh `storedAt`, so without it a stale copy plus an unreachable
 * UOA would hang a 10-second timeout off every sequential `/api/auth/me`. The
 * cooldown is stamped before the request, so at most one attempt per user per
 * `DIRECTORY_FRESH_MS` reaches UOA however the attempt ends — and a 401/403,
 * which no amount of retrying can fix, suppresses attempts until a login or
 * rotation writes a verified directory.
 *
 * The read is the same `/org/me` the login read uses, authorized the same way
 * every other on-demand `/org/*` read in this codebase is — a short-lived
 * product-signed assertion of the session's UOA subject, not a retained UOA
 * access token — and its body goes through the same parser, so the two paths
 * cannot drift.
 *
 * A failed read is not an answer. The cached copy stays exactly as it was and
 * no alert reconciliation runs: `undefined` is not a verified empty directory,
 * and treating it as one would delete every pending invitation row on a UOA
 * outage (`docs/standards/user-alerts.md`).
 */

export type UoaDirectoryRefreshDeps = {
  fetchImpl?: PinnedFetch
  resolveHost?: ResolveHost
  /** Test seam / explicit injection; defaults to the process environment. */
  settings?: UoaDelegatedIdentitySettings | null
}

export type UoaDirectoryRefreshInput = {
  /** The local organisation whose bell owns this person's invitation rows. */
  organizationId: string
  identity: UoaSessionIdentity | undefined
  now?: number
  userId: string
}

/**
 * One in-flight refresh per user. A page load fires several `/api/auth/me`
 * calls at once (shell, restore, a remount), and without this every one of them
 * would open its own UOA request for the same answer. Followers await the
 * leader's promise, so a burst costs exactly one read.
 */
const inFlightByUserId = new Map<string, Promise<void>>()

/** Test seam: forget in-flight refreshes between cases. */
export const clearUoaDirectoryRefreshState = (): void => {
  inFlightByUserId.clear()
}

/**
 * A verified answer, an ordinary failure worth retrying after the cooldown, or
 * UOA refusing this session's assertion — which only a new session can fix.
 */
type DirectoryReadResult =
  | { kind: 'verified'; directory: UoaTeamDirectory }
  | { kind: 'failed' }
  | { kind: 'refused' }

const readDirectoryFromUoa = async (
  settings: UoaDelegatedIdentitySettings,
  identity: UoaSessionIdentity & { tokenVersion: number },
  deps: UoaDirectoryRefreshDeps,
): Promise<DirectoryReadResult> => {
  try {
    const payload = await requestUoaOrganization(
      settings,
      '/org/me',
      { method: 'GET' },
      {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
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
      },
    )
    const directory = parseUoaTeamDirectoryPayload(payload, settings.authBaseUrl)
    if (!directory) {
      console.warn('[uoa] directory freshness read returned no organisation context')
      return { kind: 'failed' }
    }
    return { kind: 'verified', directory }
  } catch (error) {
    if (error instanceof UoaOrgRequestRejectedError) {
      console.warn(`[uoa] directory freshness read refused: ${error.message}`)
      // 401/403 is UOA rejecting the subject assertion itself — the epoch moved
      // on, or the account was deactivated. A minute later it will say the same
      // thing. Any other refusal is treated as an ordinary failure.
      return error.statusCode === 401 || error.statusCode === 403
        ? { kind: 'refused' }
        : { kind: 'failed' }
    }
    if (error instanceof UoaOrgRequestUnavailableError) {
      console.warn(`[uoa] directory freshness read failed: ${error.message}`)
      return { kind: 'failed' }
    }
    throw error
  }
}

const runRefresh = async (
  prisma: PrismaClient,
  input: UoaDirectoryRefreshInput & {
    identity: UoaSessionIdentity & { tokenVersion: number }
  },
  settings: UoaDelegatedIdentitySettings,
  deps: UoaDirectoryRefreshDeps,
): Promise<void> => {
  const result = await readDirectoryFromUoa(settings, input.identity, deps)
  // A failed read leaves the last verified copy in place and reconciles
  // nothing. See the module comment: no answer is not a verified empty list.
  if (result.kind === 'refused') {
    suppressUoaDirectoryRefreshUntilVerifiedRead(input.userId, input.now ?? Date.now())
    return
  }
  if (result.kind === 'failed') return

  const directory = result.directory
  rememberUoaTeamDirectory(input.userId, directory)
  // An answer that did not state its invitations reconciles none of them:
  // `syncTeamInviteAlerts` deletes every row the list omits.
  const pendingInvites = directory.pendingInvites
  if (!pendingInvites) return
  try {
    await syncTeamInviteAlerts(prisma, {
      organizationId: input.organizationId,
      pendingInvites,
      userId: input.userId,
    })
  } catch (error) {
    // Display data is already correct; the durable bell row retries at the next
    // refresh, login or rotation. A failure here must never fail `/auth/me`.
    console.warn('[uoa] team invitation alert sync failed after freshness read', error)
  }
}

/**
 * Re-read the directory from UOA when the cached copy is older than
 * `DIRECTORY_FRESH_MS`, then rewrite the cache and reconcile the durable
 * invitation alerts. A fresh copy, an attempt cooldown still running, a session
 * with no UOA identity, and a deployment with no UOA credentials all return
 * without a request.
 */
export const refreshStaleUoaTeamDirectory = async (
  prisma: PrismaClient,
  input: UoaDirectoryRefreshInput,
  deps: UoaDirectoryRefreshDeps = {},
): Promise<void> => {
  const identity = input.identity
  // `tokenVersion: null` is a session that predates UOA epoch pinning; UOA
  // refuses a subject assertion without one, so there is nothing to ask with.
  if (!identity || identity.tokenVersion === null) return

  const now = input.now ?? Date.now()
  const age = readUoaTeamDirectoryAge(input.userId, now)
  if (age !== undefined && age < DIRECTORY_FRESH_MS) return
  // A previous attempt — successful, failed, or refused — may still hold the
  // cooldown. The cached copy is served either way.
  if (!mayAttemptUoaDirectoryRefresh(input.userId, now)) return

  const settings = deps.settings === undefined
    ? loadUoaDelegatedIdentitySettings()
    : deps.settings
  if (!settings) return

  const existing = inFlightByUserId.get(input.userId)
  if (existing) {
    await existing
    return
  }

  // Before the request, not after it: a read that fails or hangs must still
  // cost one upstream call per cooldown, not one per `/api/auth/me`.
  noteUoaDirectoryRefreshAttempt(input.userId, now)
  const tokenVersion = identity.tokenVersion
  const refresh = runRefresh(
    prisma,
    { ...input, identity: { ...identity, tokenVersion } },
    settings,
    deps,
  ).finally(() => {
    inFlightByUserId.delete(input.userId)
  })
  inFlightByUserId.set(input.userId, refresh)
  await refresh
}
