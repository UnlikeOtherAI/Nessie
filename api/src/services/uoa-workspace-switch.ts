import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { UoaRefreshBindingError } from './refresh-token-uoa.js'
import {
  confirmUoaDirectServiceAccess,
  UoaBillingError,
} from './uoa-billing-client.js'
import { resolveExternalWorkspaceSelection } from './identity-display.js'
import { syncUoaProductAccountLinks } from './integrations.js'
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
import { UoaSubjectConflictError } from './workspace-principal.js'

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
  // The switch rebinds only the exact person UOA re-authenticated: compare the
  // stable UOA subject, never the email (UOA may change or reassign an
  // address). A user row with no subject yet — a backfill the migration left
  // NULL as ambiguous — also fails closed here; a fresh login either adopts
  // the subject or surfaces the identity conflict for operator resolution.
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { uoaSub: true },
  })
  if (!user || user.uoaSub === null || user.uoaSub !== input.identity.externalSubject) {
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
      uoaSub: input.identity.externalSubject,
      workspace: input.identity.workspace,
    })
  } catch (error) {
    if (error instanceof UoaSubjectConflictError) {
      // A subject conflict during materialization is as permanent as a
      // binding conflict: the source credential is already consumed upstream,
      // so force a clean reauthentication rather than retaining a dead family.
      throw new UoaRefreshBindingError(error.message)
    }
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
  // Organizations map 1:1 to UOA organisations, so a cross-org switch can land
  // in an Organization this user has never signed into interactively — its
  // first-party account links (which the rescope binding advance requires) do
  // not exist yet. Run the same link sync a login runs, scoped to the TARGET
  // org. Retryable on failure: the rotation has not consumed anything local
  // yet, and the binding advance would fail closed without the link anyway.
  try {
    await syncUoaProductAccountLinks(prisma, {
      email: input.identity.email,
      externalSubject: input.identity.externalSubject,
      organizationId: context.organizationId,
      uoaTokenVersion: input.identity.uoaTokenVersion,
      userId: input.userId,
      workspace: input.identity.workspace,
    })
  } catch {
    throw new UoaSessionRefreshError(
      'The target Nessie workspace is temporarily unavailable.',
      false,
    )
  }
}
