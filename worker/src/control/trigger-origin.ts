import type { PrismaClient } from '@prisma/client'
import {
  extractTriggerEffectiveUserId,
  extractTriggerLaunchOrigin,
  isJsonRecord,
} from '@nessie/runtime'

export type TriggerExecutionOrigin = {
  organizationId: string
  projectId?: string
  teamId?: string
  userId: string | null
}

export class TriggerLaunchOriginError extends Error {
  readonly code = 'TRIGGER_LAUNCH_ORIGIN_INVALID'

  constructor(detail: string) {
    super(
      `Scheduled task cannot run because ${detail}. `
      + 'Cancel and recreate the schedule to capture its authenticated team scope.',
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
}): TriggerExecutionOrigin => {
  const config = isJsonRecord(input.config) ? input.config : null
  const hasCreatedByUserId =
    config !== null && Object.hasOwn(config, 'createdByUserId')
  const createdByUserId = extractTriggerEffectiveUserId(config)
  const launchOrigin = extractTriggerLaunchOrigin(config)

  if (hasCreatedByUserId || launchOrigin) {
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
      userId: launchOrigin.userId,
    }
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
  prisma: Pick<PrismaClient, 'team'>,
  origin: TriggerExecutionOrigin,
): Promise<void> => {
  if (!origin.teamId) {
    return
  }

  const team = await prisma.team.findFirst({
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
  if (!team) {
    throw new TriggerLaunchOriginError(
      'its saved team does not belong to its saved organization and project, '
      + 'or its saved user is no longer a member',
    )
  }
}
