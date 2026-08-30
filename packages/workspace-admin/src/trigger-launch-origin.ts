import { parseUserId, type AuthorizedActionContext } from '@nessie/schemas'

import type { ScheduledTriggerLaunchOrigin } from '@nessie/schemas'

/**
 * Capturing the identity a schedule runs as.
 *
 * A fire has no session. Signing its Ledger call needs the UOA workspace the
 * person was acting in, and the account link proves subject/status/epoch but not
 * that — so the tuple is captured from a live session and replayed, then
 * re-verified against the link at fire time.
 *
 * This lives here rather than inline in the create route because two callers now
 * need exactly the same capture: creating a schedule, and reauthorizing one
 * whose captured identity has gone stale. A second copy would be free to drift,
 * and drift in this particular code means schedules that authenticate slightly
 * differently depending on which door they came through.
 */

export type LaunchOriginCapture =
  | { kind: 'captured'; launchOrigin: ScheduledTriggerLaunchOrigin }
  /** No authenticated user, or no active team on the session. */
  | { kind: 'no_team' }
  /**
   * The deployment signs Ledger calls but this session carries no UOA identity,
   * so the schedule could never sign. Refused while somebody is here to tell,
   * rather than minted and left to fail at every sweep forever.
   */
  | { kind: 'no_uoa_identity' }

export const captureScheduledLaunchOrigin = (input: {
  actorContext: AuthorizedActionContext
  /** Whether this deployment has a Ledger signer configured. */
  ledgerSigningConfigured: boolean
}): LaunchOriginCapture => {
  const { actorContext } = input
  if (actorContext.actor.actorType !== 'user') {
    return { kind: 'no_team' }
  }

  const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
  if (!teamId) {
    return { kind: 'no_team' }
  }

  if (input.ledgerSigningConfigured && !actorContext.actionContext.uoaIdentity) {
    return { kind: 'no_uoa_identity' }
  }

  return {
    kind: 'captured',
    launchOrigin: {
      organizationId: actorContext.tenant.organizationId,
      ...(actorContext.tenant.projectId
        ? { projectId: actorContext.tenant.projectId }
        : {}),
      teamId,
      ...(actorContext.actionContext.uoaIdentity
        ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
        : {}),
      userId: parseUserId(actorContext.actor.actorId),
    } as ScheduledTriggerLaunchOrigin,
  }
}
