import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { UoaRefreshBindingError } from './refresh-token-uoa.js'
import { syncExternalOrganizationNames } from './external-organization.js'
import { resolveExternalTeamSelection } from './identity-display.js'
import { syncProfileMirrorFromClaims } from './uoa-profile-mirror.js'
import { syncExternalTeamNames } from './team-target.js'
import { advanceUoaLocalSessionBindingInTransaction } from './uoa-session-context.js'
import { syncUoaDirectoryAfterSessionCommit } from './uoa-session-context.js'
import {
  refreshUoaSession,
  UoaSessionRefreshError,
  type UoaSessionExchange,
} from './uoa-session.js'
import {
  confirmUoaTeamSwitchAccess,
  materializeUoaTeam,
  materializeUoaTeamSwitch,
} from './uoa-team-switch.js'
import { UoaTeamSwitchError } from './uoa-team-switch-intent.js'

/** Did UOA answer this refresh with a team other than the bound one? */
const teamDrifted = (
  expected: UoaSessionIdentity,
  identity: UoaSessionExchange['identity'],
): boolean => {
  const selected = resolveExternalTeamSelection(identity.team)
  return selected.organizationId !== expected.organizationId
    || selected.teamId !== expected.teamId
}

const safeSwitchCode = (
  error: UoaSessionRefreshError,
): UoaTeamSwitchError['code'] => {
  switch (error.upstreamCode) {
    case 'INTERACTION_REQUIRED':
    case 'TEAM_NOT_AVAILABLE':
    case 'TEAM_SWITCH_CONFLICT':
      return error.upstreamCode
    default:
      return 'TEAM_SWITCH_CONFLICT'
  }
}

/** One callback set for ordinary refresh and explicit/resumed UOA rescoping. */
export const createUoaRefreshCallbacks = (prisma: PrismaClient) => ({
  refreshUoaSession: async (upstream: {
    configUrl: string
    expectedIdentity: UoaSessionIdentity
    refreshToken: string
    userId: string
    teamSwitch?: { organizationId: string; teamId: string }
  }) => {
    let refreshed: Awaited<ReturnType<typeof refreshUoaSession>>
    try {
      refreshed = await refreshUoaSession(upstream)
      if (upstream.teamSwitch) {
        await materializeUoaTeamSwitch(prisma, {
          identity: refreshed.identity,
          target: upstream.teamSwitch,
          userId: upstream.userId,
        })
      } else if (
        teamDrifted(upstream.expectedIdentity, refreshed.identity)
      ) {
        // An ordinary refresh whose successor names a different team is
        // adopted, not refused (see `refreshUoaSession`). Adoption has to land
        // on a real local org/project/team, so it materializes the successor's
        // own team exactly as a switch materializes its target — and the
        // binding advance then fails closed if it still does not resolve.
        // Same-team refreshes — every ordinary rotation — skip this
        // entirely and are byte-identical to before.
        await materializeUoaTeam(prisma, {
          identity: refreshed.identity,
          userId: upstream.userId,
        })
      }
    } catch (error) {
      if (
        error instanceof UoaSessionRefreshError
        && error.safeTeamSwitchFailure
      ) {
        throw new UoaTeamSwitchError(
          safeSwitchCode(error),
          'UnlikeOtherAI refused the requested team switch.',
          true,
        )
      }
      throw error
    }
    const selected = resolveExternalTeamSelection(
      refreshed.identity.team,
    )
    if (!selected.organizationId || !selected.teamId) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI did not return the bound session team.',
      )
    }
    // The renewed access token carries the same verified profile claims a
    // login does, and the binding checks above have already proven it belongs
    // to this user, so a UOA rename reaches Nessie within a refresh rather
    // than waiting for the next interactive sign-in. The mirror is display
    // data: a write failure must never break session renewal.
    try {
      await syncProfileMirrorFromClaims(prisma, upstream.userId, {
        avatarUrl: refreshed.identity.avatarUrl,
        displayName: refreshed.identity.displayName,
      })
    } catch {
      // Intentionally ignored — see above.
    }
    // Same doctrine for `Organization.name`: a non-authoritative mirror of
    // UOA's `orgName` (per-UOA-org model), refreshed where the verified
    // directory arrives — never allowed to break session renewal.
    try {
      await syncExternalOrganizationNames(prisma, refreshed.teamDirectory?.entries)
      await syncExternalTeamNames(prisma, refreshed.teamDirectory?.entries)
    } catch {
      // Intentionally ignored — see above.
    }
    return {
      identity: {
        organizationId: selected.organizationId,
        subject: refreshed.identity.externalSubject,
        teamId: selected.teamId,
        tokenVersion: refreshed.identity.uoaTokenVersion,
      } satisfies UoaSessionIdentity,
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: new Date(
        Date.now() + refreshed.refreshTokenExpiresInSeconds * 1_000,
      ),
      // The verified `org` claim travels with the rotation so the binding
      // commit can re-project UOA's roles onto the local membership rows.
      team: refreshed.identity.team,
      teamDirectory: refreshed.teamDirectory,
    }
  },
  advanceUoaSessionBinding: async (
    input: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[1],
    transaction: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[0],
  ) => {
    await advanceUoaLocalSessionBindingInTransaction(transaction, input)
  },
  afterUoaSessionBinding: async (input: {
    nextIdentity: UoaSessionIdentity
    userId: string
    teamDirectory?: UoaSessionExchange['teamDirectory']
  }) => syncUoaDirectoryAfterSessionCommit(prisma, input),
  beforeUoaTeamSwitch: async (input: {
    sourceIdentity: UoaSessionIdentity
    target: { organizationId: string; teamId: string }
    userId: string
  }) => confirmUoaTeamSwitchAccess(input),
})
