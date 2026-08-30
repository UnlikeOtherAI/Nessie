import type { PrismaClient } from '@prisma/client'
import {
  extractTriggerEffectiveUserId,
  extractTriggerLaunchOrigin,
  isJsonRecord,
} from '@nessie/runtime'
import type { AgentTriggerType, UoaSessionIdentity } from '@nessie/schemas'

export type TriggerExecutionOrigin = {
  organizationId: string
  projectId?: string
  teamId?: string
  /**
   * The creator's UOA workspace, replayed from the trigger's launch origin.
   * Present only for schedules created once it started being captured.
   */
  uoaIdentity?: UoaSessionIdentity
  userId: string | null
}

/**
 * Why a fire was refused, as a stable code.
 *
 * The distinction that matters is the remedy, not the severity. An identity
 * that no longer verifies is repaired by an authorized person re-authorizing
 * the schedule — one click, no edit. Everything else here is a configuration or
 * entitlement fact the person has to go and change. Persisting the code (rather
 * than only a sentence) is what lets the surface offer the right button and the
 * alert say the right thing.
 */
export type TriggerLaunchOriginReason =
  /** The saved UOA identity is absent, stale, or no longer matches the link. */
  | 'uoa_identity_unverifiable'
  /** The saved user is no longer an active member of the saved organization. */
  | 'member_inactive'
  /** The saved team no longer belongs to the saved org/project, or user left. */
  | 'team_unreachable'
  /** The saved user can no longer read the target channel. */
  | 'channel_access_lost'
  /** The stored launch origin is missing, malformed, or self-inconsistent. */
  | 'launch_origin_invalid'

/**
 * The states an authorized person can repair by re-proving who they are. Every
 * other reason needs the trigger's configuration or the person's entitlements
 * to change, so offering "Reauthorize" for them would be a dead end.
 */
const REAUTHORIZABLE_REASONS: ReadonlySet<TriggerLaunchOriginReason> = new Set([
  'uoa_identity_unverifiable',
])

export class TriggerLaunchOriginError extends Error {
  readonly code = 'TRIGGER_LAUNCH_ORIGIN_INVALID'

  readonly reason: TriggerLaunchOriginReason

  /** The sentence a person reads, without the "recreate it" advice. */
  readonly detail: string

  constructor(reason: TriggerLaunchOriginReason, detail: string) {
    super(
      `Scheduled task cannot run because ${detail}.`
      + (REAUTHORIZABLE_REASONS.has(reason)
        // Reauthorizing is now a button, so the message names it rather than
        // telling people to recreate the schedule — which they could not even
        // do, since a trigger with delivery history refuses deletion.
        ? ' Sign in and reauthorize this schedule to resume it.'
        : ''),
    )
    this.name = 'TriggerLaunchOriginError'
    this.reason = reason
    this.detail = detail
  }

  /** Whether re-proving identity is the remedy, deciding the health state. */
  get isReauthorizable(): boolean {
    return REAUTHORIZABLE_REASONS.has(this.reason)
  }
}

export const resolveTriggerExecutionOrigin = (input: {
  agent: {
    organizationId: string | null
    projectId: string | null
    teamId: string | null
  }
  channelOrganizationId: string
  config: unknown
  triggerType: AgentTriggerType
}): TriggerExecutionOrigin => {
  const config = isJsonRecord(input.config) ? input.config : null
  const hasCreatedByUserId =
    config !== null && Object.hasOwn(config, 'createdByUserId')
  const hasLaunchOrigin =
    config !== null && Object.hasOwn(config, 'launchOrigin')
  const createdByUserId = extractTriggerEffectiveUserId(config)
  const launchOrigin = extractTriggerLaunchOrigin(config)

  if (hasCreatedByUserId || hasLaunchOrigin) {
    if (!createdByUserId || !launchOrigin) {
      throw new TriggerLaunchOriginError(
        'launch_origin_invalid',
        'its saved user or launch origin is missing or malformed',
      )
    }
    if (createdByUserId !== launchOrigin.userId) {
      throw new TriggerLaunchOriginError(
        'launch_origin_invalid',
        'its saved user does not match its immutable launch origin',
      )
    }
    if (
      launchOrigin.organizationId !== input.channelOrganizationId
      || (
        input.agent.organizationId !== null
        && launchOrigin.organizationId !== input.agent.organizationId
      )
    ) {
      throw new TriggerLaunchOriginError(
        'launch_origin_invalid',
        'its saved organization no longer matches the target',
      )
    }

    return {
      organizationId: launchOrigin.organizationId,
      ...(launchOrigin.projectId ? { projectId: launchOrigin.projectId } : {}),
      teamId: launchOrigin.teamId,
      // Replayed onto the run's actor context so the Ledger signer can verify
      // it against the product account link exactly as it verifies a live
      // session. Absent for schedules created before this was captured: those
      // fail closed at dispatch rather than signing as an unproven identity.
      ...(launchOrigin.uoaIdentity
        ? { uoaIdentity: launchOrigin.uoaIdentity }
        : {}),
      userId: launchOrigin.userId,
    }
  }

  const trustedAutonomousSchedule =
    config?.['createdViaTool'] === true
  if (
    (input.triggerType === 'scheduled' || input.triggerType === 'interval')
    && !trustedAutonomousSchedule
  ) {
    throw new TriggerLaunchOriginError(
      'launch_origin_invalid',
      'this legacy user-facing schedule has no authenticated launch origin',
    )
  }

  const organizationId =
    input.agent.organizationId ?? input.channelOrganizationId
  if (organizationId !== input.channelOrganizationId) {
    throw new TriggerLaunchOriginError(
      'launch_origin_invalid',
      'its agent organization no longer matches the target',
    )
  }

  return {
    organizationId,
    ...(input.agent.projectId ? { projectId: input.agent.projectId } : {}),
    ...(input.agent.teamId ? { teamId: input.agent.teamId } : {}),
    userId: null,
  }
}

export const assertTriggerExecutionOriginTenant = async (
  prisma: Pick<PrismaClient, 'organizationMember' | 'team'>,
  origin: TriggerExecutionOrigin,
): Promise<void> => {
  const [organizationMember, team] = await Promise.all([
    origin.userId
      ? prisma.organizationMember.findFirst({
          where: {
            deactivatedAt: null,
            organizationId: origin.organizationId,
            userId: origin.userId,
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    origin.teamId
      ? prisma.team.findFirst({
          where: {
            id: origin.teamId,
            ...(origin.projectId ? { projectId: origin.projectId } : {}),
            ...(origin.userId
              ? { members: { some: { userId: origin.userId } } }
              : {}),
            project: { organizationId: origin.organizationId },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ])

  if (origin.userId && !organizationMember) {
    throw new TriggerLaunchOriginError(
      'member_inactive',
      'its saved user is no longer an active member of its saved organization',
    )
  }
  if (origin.teamId && !team) {
    throw new TriggerLaunchOriginError(
      'team_unreachable',
      'its saved team does not belong to its saved organization and project, '
      + 'or its saved user is no longer a member',
    )
  }
}
