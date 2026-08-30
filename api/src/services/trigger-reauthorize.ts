import { Prisma, type PrismaClient } from '@prisma/client'
import {
  captureScheduledLaunchOrigin,
  getChannelIfMember,
  mapTriggerRecord,
  normalizeNextRunAt,
  SCHEDULER_TRIGGER_TYPES,
  TRIGGER_ADMIN_AUDIENCE,
} from '@nessie/workspace-admin'
import {
  extractTriggerLaunchOrigin,
  isJsonRecord,
  loadLedgerIdentitySettings,
} from '@nessie/runtime'
import type { AgentTriggerType, AuthorizedActionContext } from '@nessie/schemas'
import type { AgentTriggerRecord } from '../contracts.js'

const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null

/**
 * Put a schedule back to work after its captured identity stopped verifying.
 *
 * This is the recovery doorway the system did not have. Previously a trigger
 * whose UOA identity drifted was flipped to `error` and could be neither fixed
 * nor removed — editing preserves the server-owned identity deliberately,
 * resuming re-armed it into the same failure, and deletion is refused once any
 * delivery exists. The advice in the error text ("recreate the schedule") was
 * not something the API could actually do.
 *
 * Deliberately NOT an automatic re-stamp on login. Proving that the same person
 * signed in somewhere is not the same as their deciding that this particular
 * dormant automation should start running again — and a credential epoch may
 * have rotated precisely because access was revoked. Recovery is an explicit,
 * audited act.
 */

export type ReauthorizeTriggerResult =
  | { kind: 'ok'; trigger: AgentTriggerRecord }
  | { kind: 'error'; code: ReauthorizeTriggerErrorCode; message: string; status: number }

export type ReauthorizeTriggerErrorCode =
  | 'TRIGGER_NOT_FOUND'
  | 'TRIGGER_NOT_REAUTHORIZABLE'
  | 'TRIGGER_REAUTHORIZE_FORBIDDEN'
  | 'TRIGGER_LAUNCH_ORIGIN_REQUIRED'
  | 'TRIGGER_UOA_IDENTITY_REQUIRED'
  | 'TRIGGER_WORKSPACE_CHANGED'
  | 'TRIGGER_TARGET_UNREACHABLE'
  | 'TRIGGER_NOT_REARMABLE'

const failure = (
  code: ReauthorizeTriggerErrorCode,
  message: string,
  status: number,
): ReauthorizeTriggerResult => ({ kind: 'error', code, message, status })

export const reauthorizeAgentTrigger = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    isOwner: boolean
    /**
     * Take ownership of somebody else's schedule, re-pointing it at the
     * caller's own workspace. Owner-only and never implicit: re-pointing a
     * schedule's team silently would move its billing attribution.
     */
    takeOver?: boolean
    triggerId: string
  },
): Promise<ReauthorizeTriggerResult> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: input.triggerId },
    select: {
      config: true,
      id: true,
      targetChannelId: true,
      type: true,
    },
  })
  if (!trigger) {
    return failure('TRIGGER_NOT_FOUND', 'Trigger not found', 404)
  }

  if (!SCHEDULER_TRIGGER_TYPES.includes(trigger.type as AgentTriggerType)) {
    return failure(
      'TRIGGER_NOT_REAUTHORIZABLE',
      'Only scheduled and interval triggers carry a launch identity.',
      409,
    )
  }

  const storedOrigin = extractTriggerLaunchOrigin(
    isJsonRecord(trigger.config) ? trigger.config : null,
  )
  if (!storedOrigin) {
    return failure(
      'TRIGGER_NOT_REAUTHORIZABLE',
      'This schedule has no captured launch identity to refresh.',
      409,
    )
  }

  const actorUserId = input.actorContext.actor.actorId
  const isCreator = storedOrigin.userId === actorUserId
  if (!isCreator && !input.isOwner) {
    return failure(
      'TRIGGER_REAUTHORIZE_FORBIDDEN',
      'Only the person who created this schedule, or an organization owner, can reauthorize it.',
      403,
    )
  }

  const captured = captureScheduledLaunchOrigin({
    actorContext: input.actorContext,
    ledgerSigningConfigured,
  })
  if (captured.kind === 'no_team') {
    return failure(
      'TRIGGER_LAUNCH_ORIGIN_REQUIRED',
      'Reauthorizing needs an authenticated user with an active team.',
      400,
    )
  }
  if (captured.kind === 'no_uoa_identity') {
    return failure(
      'TRIGGER_UOA_IDENTITY_REQUIRED',
      'Reauthorizing needs an UnlikeOtherAI SSO session. Sign in through SSO and try again.',
      400,
    )
  }

  // Re-stamp the epoch, never silently re-point the workspace.
  //
  // The stale part of a drifted identity is its credential epoch; the
  // organisation and team are what the schedule is attributed to and billed
  // through. Refreshing those from whoever happens to be reauthorizing would
  // move an old schedule onto a different team's account — quietly, as a side
  // effect of clicking a repair button. So a genuine workspace change is
  // refused and named, and taking a schedule over is a separate explicit act.
  const sameWorkspace =
    captured.launchOrigin.organizationId === storedOrigin.organizationId
    && captured.launchOrigin.teamId === storedOrigin.teamId
  if (!input.takeOver) {
    if (!isCreator) {
      return failure(
        'TRIGGER_REAUTHORIZE_FORBIDDEN',
        'This schedule belongs to somebody else. Take it over explicitly to run it as yourself.',
        403,
      )
    }
    if (!sameWorkspace) {
      return failure(
        'TRIGGER_WORKSPACE_CHANGED',
        'Your active workspace differs from the one this schedule was created in. '
        + 'Switch back to that workspace to reauthorize it, or take it over to move it to this one.',
        409,
      )
    }
  }

  // The identity is only as good as the reach it implies: whoever the schedule
  // will now run as must still be able to read the room it posts into.
  if (trigger.targetChannelId) {
    const channel = await getChannelIfMember(
      prisma,
      captured.launchOrigin.userId,
      captured.launchOrigin.organizationId,
      trigger.targetChannelId,
    )
    if (!channel) {
      return failure(
        'TRIGGER_TARGET_UNREACHABLE',
        'The identity being applied cannot reach this schedule\'s target channel.',
        409,
      )
    }
  }

  // Re-arm from now, never from the occurrence it missed. A cron schedule
  // computes its next time from the previous scheduled time, so a trigger that
  // has been dead for weeks would otherwise wake up and grind through every
  // missed occurrence one sweep at a time.
  const config = isJsonRecord(trigger.config) ? { ...trigger.config } : {}
  const nextRunAt = normalizeNextRunAt({
    config,
    type: trigger.type as AgentTriggerType,
  })
  if (!nextRunAt) {
    return failure(
      'TRIGGER_NOT_REARMABLE',
      'This schedule has no future occurrence left — a one-off that already ran, '
      + 'or a recurrence past its end date. Give it a new schedule instead.',
      409,
    )
  }

  const nextConfig = {
    ...config,
    createdByUserId: captured.launchOrigin.userId,
    launchOrigin: {
      ...(input.takeOver
        ? captured.launchOrigin
        : { ...storedOrigin, uoaIdentity: captured.launchOrigin.uoaIdentity }),
    },
  }

  const updated = await prisma.agentTrigger.update({
    where: { id: trigger.id },
    data: {
      config: nextConfig as Prisma.InputJsonValue,
      enabled: true,
      healthDetail: null,
      healthReason: null,
      nextRunAt,
      status: 'active',
    },
  })

  return { kind: 'ok', trigger: mapTriggerRecord(updated, TRIGGER_ADMIN_AUDIENCE) }
}
