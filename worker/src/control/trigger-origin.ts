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

export class TriggerLaunchOriginError extends Error {
  readonly code = 'TRIGGER_LAUNCH_ORIGIN_INVALID'

  constructor(detail: string) {
    super(
      `Scheduled task cannot run because ${detail}. `
      + 'Sign in again if needed, then recreate the schedule so it captures '
      + 'your current authenticated team and UnlikeOtherAI identity.',
    )
    this.name = 'TriggerLaunchOriginError'
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
        'its saved user or launch origin is missing or malformed',
      )
    }
    if (createdByUserId !== launchOrigin.userId) {
      throw new TriggerLaunchOriginError(
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
      'this legacy user-facing schedule has no authenticated launch origin',
    )
  }

  const organizationId =
    input.agent.organizationId ?? input.channelOrganizationId
  if (organizationId !== input.channelOrganizationId) {
    throw new TriggerLaunchOriginError(
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
      'its saved user is no longer an active member of its saved organization',
    )
  }
  if (origin.teamId && !team) {
    throw new TriggerLaunchOriginError(
      'its saved team does not belong to its saved organization and project, '
      + 'or its saved user is no longer a member',
    )
  }
}
