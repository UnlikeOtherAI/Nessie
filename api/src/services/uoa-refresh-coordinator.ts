import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { UoaRefreshBindingError } from './refresh-token-uoa.js'
import { syncExternalOrganizationNames } from './external-organization.js'
import { resolveExternalWorkspaceSelection } from './identity-display.js'
import { syncProfileMirrorFromClaims } from './uoa-profile-mirror.js'
import {
  advanceUoaLocalSessionBindingInTransaction,
  rescopeUoaLocalSessionBindingInTransaction,
} from './uoa-session-context.js'
import {
  refreshUoaSession,
  UoaSessionRefreshError,
} from './uoa-session.js'
import {
  confirmUoaWorkspaceSwitchAccess,
  materializeUoaWorkspaceSwitch,
} from './uoa-workspace-switch.js'
import { UoaWorkspaceSwitchError } from './uoa-workspace-switch-intent.js'

const safeSwitchCode = (
  error: UoaSessionRefreshError,
): UoaWorkspaceSwitchError['code'] => {
  switch (error.upstreamCode) {
    case 'INTERACTION_REQUIRED':
    case 'WORKSPACE_NOT_AVAILABLE':
    case 'WORKSPACE_SWITCH_CONFLICT':
      return error.upstreamCode
    default:
      return 'WORKSPACE_SWITCH_CONFLICT'
  }
}

/** One callback set for ordinary refresh and explicit/resumed UOA rescoping. */
export const createUoaRefreshCallbacks = (prisma: PrismaClient) => ({
  refreshUoaSession: async (upstream: {
    configUrl: string
    expectedIdentity: UoaSessionIdentity
    refreshToken: string
    userId: string
    workspaceSwitch?: { organizationId: string; teamId: string }
  }) => {
    let refreshed: Awaited<ReturnType<typeof refreshUoaSession>>
    try {
      refreshed = await refreshUoaSession(upstream)
      if (upstream.workspaceSwitch) {
        await materializeUoaWorkspaceSwitch(prisma, {
          identity: refreshed.identity,
          target: upstream.workspaceSwitch,
          userId: upstream.userId,
        })
      }
    } catch (error) {
      if (
        error instanceof UoaSessionRefreshError
        && error.safeWorkspaceSwitchFailure
      ) {
        throw new UoaWorkspaceSwitchError(
          safeSwitchCode(error),
          'UnlikeOtherAI refused the requested workspace switch.',
          true,
        )
      }
      throw error
    }
    const selected = resolveExternalWorkspaceSelection(
      refreshed.identity.workspace,
    )
    if (!selected.organizationId || !selected.teamId) {
      throw new UoaRefreshBindingError(
        'UnlikeOtherAI did not return the bound session workspace.',
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
      await syncExternalOrganizationNames(prisma, refreshed.workspaceDirectory)
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
      workspace: refreshed.identity.workspace,
      workspaceDirectory: refreshed.workspaceDirectory,
    }
  },
  advanceUoaSessionBinding: async (
    input: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[1],
    transaction: Parameters<typeof advanceUoaLocalSessionBindingInTransaction>[0],
  ) => {
    await advanceUoaLocalSessionBindingInTransaction(transaction, input)
  },
  rescopeUoaSessionBinding: async (
    input: Parameters<typeof rescopeUoaLocalSessionBindingInTransaction>[1],
    transaction: Parameters<typeof rescopeUoaLocalSessionBindingInTransaction>[0],
  ) => {
    await rescopeUoaLocalSessionBindingInTransaction(transaction, input)
  },
  beforeUoaWorkspaceSwitch: async (input: {
    sourceIdentity: UoaSessionIdentity
    target: { organizationId: string; teamId: string }
    userId: string
  }) => confirmUoaWorkspaceSwitchAccess(input),
})
