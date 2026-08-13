import { AuthSessionApiError, type SessionPayload } from '@nessie/client-core'
import { activeWorkspace, type Workspace } from '../../lib/workspaces'
import { workspaceSwitchFailureMessage } from './workspace-switch-message'

export type WorkspaceSwitchRecoveryResult =
  | { outcome: 'switched' }
  | { message: string; outcome: 'failed' }

const REAUTHENTICATION_CODES = new Set([
  'INVALID_REFRESH_TOKEN',
  'WORKSPACE_SWITCH_REAUTH_REQUIRED',
])

const matchesWorkspace = (current: Workspace | null, target: Workspace): boolean => Boolean(
  current
  && current.organizationId === target.organizationId
  && current.projectId === target.projectId
  && current.teamId === target.teamId
)

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

  if (code === 'INTERACTION_REQUIRED') {
    return {
      message: workspaceSwitchFailureMessage({
        code,
        currentWorkspace: input.currentWorkspace?.label,
        targetWorkspace: input.targetWorkspace.label,
      }),
      outcome: 'failed',
    }
  }

  let payload: SessionPayload | null
  try {
    payload = await input.reconcileSession()
  } catch {
    return {
      message: workspaceSwitchFailureMessage({
        state: code && REAUTHENTICATION_CODES.has(code) ? 'reauthenticate' : 'unknown',
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
