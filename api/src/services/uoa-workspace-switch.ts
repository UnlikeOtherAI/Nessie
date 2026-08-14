import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { UoaRefreshBindingError } from './refresh-token-uoa.js'
import {
  confirmUoaDirectServiceAccess,
  UoaBillingError,
} from './uoa-billing-client.js'
import { resolveExternalWorkspaceSelection } from './identity-display.js'
import {
  UoaSessionRefreshError,
  type UoaSessionExchange,
  type UoaWorkspaceSwitchTarget,
} from './uoa-session.js'
import { UoaWorkspaceSwitchError } from './uoa-workspace-switch-intent.js'
import {
  resolveUoaWorkspaceContext,
  WorkspaceExternalBindingConflictError,
} from './workspace-context.js'

const mapDirectAccessFailure = (error: UoaBillingError): never => {
  if (
    error.code === 'UOA_BILLING_FORBIDDEN'
    || error.code === 'UOA_BILLING_CONTEXT_MISMATCH'
  ) {
    throw new UoaWorkspaceSwitchError(
      'WORKSPACE_NOT_AVAILABLE',
      'UnlikeOtherAI did not confirm Nessie access in the target workspace.',
      true,
    )
  }
  if (
    error.code === 'UOA_BILLING_REAUTH_REQUIRED'
    || error.code === 'UOA_BILLING_SSO_REQUIRED'
  ) {
    throw new UoaWorkspaceSwitchError(
      'INTERACTION_REQUIRED',
      'UnlikeOtherAI requires an interactive sign-in for this workspace.',
      true,
    )
  }
  throw new UoaSessionRefreshError(
    'UnlikeOtherAI access confirmation is temporarily unavailable.',
    false,
  )
}

/** Confirm exact target entitlement before presenting the source credential. */
export const confirmUoaWorkspaceSwitchAccess = async (
  input: {
    sourceIdentity: UoaSessionIdentity
    target: UoaWorkspaceSwitchTarget
  },
): Promise<void> => {
  if (input.sourceIdentity.tokenVersion === null) {
    throw new UoaRefreshBindingError(
      'The UnlikeOtherAI source session is missing its credential epoch.',
    )
  }
  try {
    await confirmUoaDirectServiceAccess({
      organizationId: input.target.organizationId,
      teamId: input.target.teamId,
      tokenVersion: input.sourceIdentity.tokenVersion,
      userId: input.sourceIdentity.subject,
    })
  } catch (error) {
    if (error instanceof UoaBillingError) return mapDirectAccessFailure(error)
    throw error
  }
}

/**
 * Idempotently materialize the exact target proven by UOA's successful switch
 * response. This deliberately runs after UOA returns so existing-workspace
 * role mapping uses the authoritative target claims rather than fabricated
 * source-session data.
 */
export const materializeUoaWorkspaceSwitch = async (
  prisma: PrismaClient,
  input: {
    identity: UoaSessionExchange['identity']
    target: UoaWorkspaceSwitchTarget
    userId: string
  },
): Promise<void> => {
  const selected = resolveExternalWorkspaceSelection(input.identity.workspace)
  if (
    selected.organizationId !== input.target.organizationId
    || selected.teamId !== input.target.teamId
  ) {
    throw new UoaRefreshBindingError(
      'UnlikeOtherAI returned a different workspace while materializing the switch.',
    )
  }
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  })
  if (
    !user
    || user.email.trim().toLowerCase() !== input.identity.email.trim().toLowerCase()
  ) {
    throw new UoaRefreshBindingError(
      'The Nessie user no longer matches this UnlikeOtherAI session.',
    )
  }
  let context: Awaited<ReturnType<typeof resolveUoaWorkspaceContext>>
  try {
    context = await resolveUoaWorkspaceContext(prisma, {
      avatarUrl: input.identity.avatarUrl,
      displayName: input.identity.displayName,
      email: input.identity.email,
      workspace: input.identity.workspace,
    })
  } catch (error) {
    if (error instanceof WorkspaceExternalBindingConflictError) {
      // UOA has already consumed the source credential at this point. Keeping
      // the old local family would retain an unusable upstream secret, so a
      // permanent local binding conflict must force a clean reauthentication.
      throw new UoaRefreshBindingError(error.message)
    }
    throw new UoaSessionRefreshError(
      'The target Nessie workspace is temporarily unavailable.',
      false,
    )
  }
  if (!context || context.userId !== input.userId) {
    throw new UoaSessionRefreshError(
      'The target Nessie workspace is temporarily unavailable.',
      false,
    )
  }
}
