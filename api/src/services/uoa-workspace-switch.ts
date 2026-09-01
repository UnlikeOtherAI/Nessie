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
import { UoaUnrecognizedRoleError } from './uoa-roles.js'
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
 * Idempotently materialize the local org/project/team for the workspace UOA
 * itself proved in an authenticated response, so the session binding can then
 * resolve it. Two callers, one implementation: an explicit switch (through
 * `materializeUoaWorkspaceSwitch`, which first pins the response to the
 * requested target) and an ordinary refresh whose successor carries a drifted
 * workspace — adopting that drift has to land somewhere real or fail closed,
 * exactly as a switch does. This deliberately runs after UOA returns so role
 * mapping uses the authoritative claims rather than fabricated source data.
 */
export const materializeUoaWorkspace = async (
  prisma: PrismaClient,
  input: {
    identity: UoaSessionExchange['identity']
    userId: string
  },
): Promise<void> => {
  // The rebind covers only the exact person UOA re-authenticated: compare the
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
    if (error instanceof UoaUnrecognizedRoleError) {
      // The target workspace claims a role this deployment cannot express as a
      // local standing. Refuse the switch outright — a coerced standing is the
      // bug this fixes — and clear the intent, since retrying cannot help until
      // the domain's role vocabulary changes.
      throw new UoaWorkspaceSwitchError(
        'WORKSPACE_NOT_AVAILABLE',
        error.message,
        true,
      )
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
  // Organizations map 1:1 to UOA organisations, so a cross-org switch or an
  // adopted drift can land in an Organization this user has never signed into
  // interactively — its first-party account links (which the binding advance
  // requires) do not exist yet. Run the same link sync a login runs, scoped to
  // the resolved org. Retryable on failure: the rotation has not consumed
  // anything local yet, and the binding advance would fail closed without the
  // link anyway.
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

/**
 * Materialize an explicit switch: the response must prove the exact workspace
 * the caller requested (requirement 2d) before anything local is touched.
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
  await materializeUoaWorkspace(prisma, {
    identity: input.identity,
    userId: input.userId,
  })
}
