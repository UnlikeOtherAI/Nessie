import { AuthSessionApiError, type SessionPayload } from '@nessie/client-core'
import { activeTeam, type Team } from '../../lib/teams'
import { teamSwitchFailureMessage } from './team-switch-message'

export type TeamSwitchRecoveryResult =
  // Proof of the target team is missing or no longer renewable — the
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
  'TEAM_SWITCH_REAUTH_REQUIRED',
])

const matchesTeam = (current: Team | null, target: Team): boolean => Boolean(
  current
  && current.organizationId === target.organizationId
  && current.projectId === target.projectId
  && current.teamId === target.teamId
)

/**
 * Classify a team-switch failure before touching the session. Missing or
 * non-renewable target proof is a dedicated reauthorization outcome — the
 * current UI/session stays exactly as it is (a session must never be cleared
 * merely because the refresh cookie is absent). Anything ambiguous still
 * reconciles through the ordinary refresh funnel.
 */
export const classifyTeamSwitchFailure = (
  error: unknown,
): 'ambiguous' | 'reauthorize' =>
  error instanceof AuthSessionApiError
    && error.code !== undefined
    && REAUTHORIZATION_CODES.has(error.code)
    ? 'reauthorize'
    : 'ambiguous'

/**
 * A team-switch response can be lost after its rotated cookie is stored.
 * Reconcile ambiguous failures through the ordinary refresh funnel before the
 * picker reports a retained team or permits another switch attempt.
 */
export const recoverTeamSwitchFailure = async (input: {
  currentTeam: Team | null
  error: unknown
  reconcileSession: () => Promise<SessionPayload | null>
  targetTeam: Team
}): Promise<TeamSwitchRecoveryResult> => {
  const code = input.error instanceof AuthSessionApiError
    ? input.error.code
    : undefined

  if (classifyTeamSwitchFailure(input.error) === 'reauthorize') {
    return { outcome: 'reauthorize' }
  }

  let payload: SessionPayload | null
  try {
    payload = await input.reconcileSession()
  } catch {
    return {
      message: teamSwitchFailureMessage({
        state: 'unknown',
        targetTeam: input.targetTeam.label,
      }),
      outcome: 'failed',
    }
  }

  if (!payload) {
    return {
      message: teamSwitchFailureMessage({
        state: 'reauthenticate',
        targetTeam: input.targetTeam.label,
      }),
      outcome: 'failed',
    }
  }

  const reconciledTeam = activeTeam(payload.me)
  if (matchesTeam(reconciledTeam, input.targetTeam)) {
    return { outcome: 'switched' }
  }

  if (!reconciledTeam) {
    return {
      message: teamSwitchFailureMessage({
        state: 'unknown',
        targetTeam: input.targetTeam.label,
      }),
      outcome: 'failed',
    }
  }

  return {
    message: teamSwitchFailureMessage({
      code,
      currentTeam: reconciledTeam.label,
      targetTeam: input.targetTeam.label,
    }),
    outcome: 'failed',
  }
}
