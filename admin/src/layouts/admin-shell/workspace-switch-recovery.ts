import { AuthSessionApiError, type SessionPayload } from '@nessie/client-core'
import { activeWorkspace, type Workspace } from '../../lib/workspaces'
import { workspaceSwitchFailureMessage } from './workspace-switch-message'

export type WorkspaceSwitchRecoveryResult =
  // Proof of the target workspace is missing or no longer renewable — the
  // caller must re-enter SSO for the exact target. The current session is
  // retained; reconcileSession is never consulted for this outcome.
  | { outcome: 'reauthorize' }
  | { outcome: 'switched' }
  | { message: string; outcome: 'failed' }

// Definitive "renew the proof in person" answers. Unlike a network failure or
// a switch conflict, these can never resolve through refresh reconciliation:
// the source refresh credential is absent, revoked, or upstream-refused.
const REAUTHORIZATION_CODES = new Set([
  'INTERACTION_REQUIRED',
  'INVALID_REFRESH_TOKEN',
  'NO_REFRESH_TOKEN',
  'WORKSPACE_SWITCH_REAUTH_REQUIRED',
])

const matchesWorkspace = (current: Workspace | null, target: Workspace): boolean => Boolean(
  current
  && current.organizationId === target.organizationId
  && current.projectId === target.projectId
  && current.teamId === target.teamId
)

/**
 * Classify a workspace-switch failure before touching the session. Missing or
 * non-renewable target proof is a dedicated reauthorization outcome — the
 * current UI/session stays exactly as it is (a session must never be cleared
 * merely because the refresh cookie is absent). Anything ambiguous still
 * reconciles through the ordinary refresh funnel.
 */
export const classifyWorkspaceSwitchFailure = (
  error: unknown,
): 'ambiguous' | 'reauthorize' =>
  error instanceof AuthSessionApiError
    && error.code !== undefined
    && REAUTHORIZATION_CODES.has(error.code)
    ? 'reauthorize'
    : 'ambiguous'

/**
 * A workspace-switch response can be lost after its rotated cookie is stored.
 * Reconcile ambiguous failures through the ordinary refresh funnel before the
 * picker reports a retained workspace or permits another switch attempt.
 */
export const recoverWorkspaceSwitchFailure = async (input: {
  currentWorkspace: Workspace | null
  error: unknown
  reconcileSession: () => Promise<SessionPayload | null>
  targetWorkspace: Workspace
}): Promise<WorkspaceSwitchRecoveryResult> => {
  const code = input.error instanceof AuthSessionApiError
    ? input.error.code
    : undefined

  if (classifyWorkspaceSwitchFailure(input.error) === 'reauthorize') {
    return { outcome: 'reauthorize' }
  }

  let payload: SessionPayload | null
  try {
    payload = await input.reconcileSession()
  } catch {
    return {
      message: workspaceSwitchFailureMessage({
        state: 'unknown',
        targetWorkspace: input.targetWorkspace.label,
      }),
      outcome: 'failed',
    }
  }

  if (!payload) {
    return {
      message: workspaceSwitchFailureMessage({
        state: 'reauthenticate',
        targetWorkspace: input.targetWorkspace.label,
      }),
      outcome: 'failed',
    }
  }

  const reconciledWorkspace = activeWorkspace(payload.me)
  if (matchesWorkspace(reconciledWorkspace, input.targetWorkspace)) {
    return { outcome: 'switched' }
  }

  if (!reconciledWorkspace) {
    return {
      message: workspaceSwitchFailureMessage({
        state: 'unknown',
        targetWorkspace: input.targetWorkspace.label,
      }),
      outcome: 'failed',
    }
  }

  return {
    message: workspaceSwitchFailureMessage({
      code,
      currentWorkspace: reconciledWorkspace.label,
      targetWorkspace: input.targetWorkspace.label,
    }),
    outcome: 'failed',
  }
}
