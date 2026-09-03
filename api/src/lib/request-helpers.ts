import type { ChannelSystemType, PrismaClient } from '@prisma/client'
import {
  PersonalAssistantConfigSummarySchema,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'
import {
  PersonalAssistantStateResponseSchema,
  ThreadRecordSchema,
} from '../contracts.js'
import {
  ensureDefaultThread,
  getChannelIfMember as getChannelIfMemberShared,
  isAgentAccessibleToActor as isAgentAccessibleToActorShared,
  isAgentVisibleToUser as isAgentVisibleToUserShared,
  isProjectAccessibleToUser,
  listAccessibleProjectIds as listAccessibleProjectIdsShared,
  loadLastMessageAtByThread,
  readAgentVoiceName,
} from '@nessie/workspace-admin'

/**
 * Request-scoped authorization + visibility helpers. These all close over the
 * shared Prisma client and were previously inlined in `index.ts`/`server-context`.
 * Extracted into their own factory so neither file breaches the 500-line cap
 * (AGENTS.md). Behaviour is unchanged — pure code movement.
 */
export const createRequestHelpers = (prisma: PrismaClient) => {
  const isPersonalAssistantChannelType = (
    value: string | null | undefined,
  ): value is 'personal_assistant' => value === 'personal_assistant'

  /**
   * The single-member private DMs whose one bound agent acts as the person it
   * is talking to: the Personal Assistant's, and a global agent's home DM.
   * Both hold exactly one member — enforced by the deferred `channel_members`
   * trigger for the `gagent:` shape — which is what makes stamping
   * `effectiveUserId = poster` safe, and what makes the organization-wide
   * realtime scope wrong for them.
   */
  const isDelegatedSystemDmChannelType = (
    value: string | null | undefined,
  ): value is 'personal_assistant' | 'system_agent' =>
    value === 'personal_assistant' || value === 'system_agent'

  const buildChannelRealtimeScopes = (input: {
    channelId: string
    organizationId: string
    systemChannelType?: string | null
  }): WsScope[] =>
    isDelegatedSystemDmChannelType(input.systemChannelType)
      ? [{ kind: 'channel', channelId: parseChannelId(input.channelId) }]
      : [
          {
            kind: 'organization',
            organizationId: parseOrganizationId(input.organizationId),
          },
          { kind: 'channel', channelId: parseChannelId(input.channelId) },
        ]

  const buildPersonalAssistantConfigSummary = (agent: {
    id: string
    model: string | null
    provider: string | null
    systemPrompt: string | null
    toolPolicy: unknown
    updatedAt: Date
  }) =>
    PersonalAssistantConfigSummarySchema.parse({
      agentId: parseAgentId(agent.id),
      model: agent.model ?? undefined,
      provider: agent.provider ?? undefined,
      systemPromptPreview: agent.systemPrompt?.slice(0, 200) ?? undefined,
      toolIds:
        agent.toolPolicy
        && typeof agent.toolPolicy === 'object'
        && !Array.isArray(agent.toolPolicy)
          ? Object.entries(agent.toolPolicy as Record<string, unknown>)
              .filter(([, enabled]) => enabled === true)
              .map(([toolId]) => toolId)
              .sort()
          : [],
      updatedAt: agent.updatedAt.toISOString(),
    })

  const loadPersonalAssistantState = async (
    actorContext: AuthorizedActionContext & {
      actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
    },
  ) => {
    const userId = actorContext.actionContext.effectiveUserId ?? actorContext.actor.actorId
    const dmKey = `pa:${actorContext.tenant.organizationId}:${userId}`
    const channel = await prisma.channel.findUnique({
      where: { dmKey },
      select: {
        createdAt: true,
        id: true,
        label: true,
        organizationId: true,
        slug: true,
        systemChannelType: true,
        teamId: true,
        type: true,
        updatedAt: true,
        visibility: true,
        team: {
          select: {
            name: true,
            project: {
              select: { channelRoot: true, id: true, name: true },
            },
          },
        },
        members: {
          where: { userId },
          select: { id: true },
          take: 1,
        },
        agentBindings: {
          orderBy: { createdAt: 'asc' },
          select: { agentId: true },
          take: 1,
        },
      },
    })

    if (
      !channel
      || channel.organizationId !== actorContext.tenant.organizationId
      || channel.members.length === 0
      || !isPersonalAssistantChannelType(channel.systemChannelType)
    ) {
      return null
    }

    const defaultThreadId = await ensureDefaultThread(prisma, channel.id)
    const thread = await prisma.thread.findUnique({
      where: { id: defaultThreadId },
      select: {
        channelId: true,
        createdAt: true,
        id: true,
        title: true,
        updatedAt: true,
      },
    })
    if (!thread) {
      return null
    }

    const agent = channel.agentBindings[0]?.agentId
      ? await prisma.agent.findUnique({
          where: { id: channel.agentBindings[0].agentId },
          select: {
            agentKind: true,
            avatarAttachmentId: true,
            avatarBackgroundColor: true,
            bindings: {
              where: { channelId: channel.id },
              orderBy: { createdAt: 'asc' },
              select: { channelId: true },
            },
            createdAt: true,
            delegationMode: true,
            id: true,
            messages: {
              where: { threadId: thread.id },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
              take: 1,
            },
            model: true,
            name: true,
            provider: true,
            role: true,
            runs: {
              where: { threadId: thread.id },
              include: {
                toolCalls: {
                  orderBy: { startedAt: 'desc' },
                  select: {
                    endedAt: true,
                    startedAt: true,
                    toolName: true,
                  },
                  take: 1,
                },
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            status: true,
            surfacePolicy: true,
            todosEnabled: true,
            voiceName: true,
            speakingStyle: true,
            systemManaged: true,
            systemPrompt: true,
            toolPolicy: true,
            updatedAt: true,
            visibility: true,
          },
        })
      : null
    // The PA channel record is built here rather than through mapChannelRecord,
    // so its recency has to be loaded here too — every emission of a channel
    // record carries lastMessageAt.
    const lastMessageAt = (await loadLastMessageAtByThread(prisma, [thread.id])).get(thread.id)
    const latestRun = agent?.runs[0]
    const latestToolCall = latestRun?.toolCalls[0]
    const latestMessage = agent?.messages[0]
    const isActiveRun =
      latestRun !== undefined
      && latestRun.status !== 'completed'
      && latestRun.status !== 'failed'
      && latestRun.status !== 'cancelled'
    const lastActivityAt =
      latestToolCall?.startedAt
      ?? latestMessage?.createdAt
      ?? latestRun?.createdAt
      ?? agent?.updatedAt
      ?? channel.updatedAt

    return PersonalAssistantStateResponseSchema.parse({
      agent: agent
        ? {
            id: parseAgentId(agent.id),
            name: agent.name,
            role: agent.role,
            status: agent.status,
            agentKind: agent.agentKind,
            systemManaged: agent.systemManaged,
            visibility: agent.visibility,
            surfacePolicy: agent.surfacePolicy,
            delegationMode: agent.delegationMode,
            currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
            currentToolName:
              isActiveRun && latestToolCall?.endedAt === null ? latestToolCall.toolName : undefined,
            currentToolStartedAt:
              isActiveRun && latestToolCall?.endedAt === null
                ? latestToolCall.startedAt.toISOString()
                : undefined,
            lastActivityAt: lastActivityAt.toISOString(),
            parentAgentId: null,
            provider: agent.provider ?? undefined,
            model: agent.model ?? undefined,
            avatarAttachmentId: agent.avatarAttachmentId ?? undefined,
            avatarBackgroundColor: agent.avatarBackgroundColor ?? undefined,
            createdAt: agent.createdAt.toISOString(),
            updatedAt: agent.updatedAt.toISOString(),
            channelIds: agent.bindings.map((binding) => parseChannelId(binding.channelId)),
            todosEnabled: agent.todosEnabled,
            // Every other agent record carries the prompt (`mapAgentRecord`);
            // this one is hand-built, and omitting it here meant the
            // assistant's standing instructions reached a typed run but never
            // a call — silently, because the field is optional on the schema.
            systemPrompt: agent.systemPrompt ?? undefined,
            // The voice-call broker reads both off this record: a call is
            // always with the caller's own assistant, resolved here.
            voiceName: readAgentVoiceName(agent.voiceName),
            speakingStyle: agent.speakingStyle,
          }
        : null,
      channel: {
        id: parseChannelId(channel.id),
        label: channel.label,
        slug: channel.slug,
        type: channel.type,
        systemChannelType: channel.systemChannelType,
        visibility: channel.visibility,
        organizationId: parseOrganizationId(channel.organizationId),
        scope: channel.team.project.channelRoot ? 'standalone' : 'project',
        projectId: parseProjectId(channel.team.project.id),
        projectName: channel.team.project.name,
        teamId: parseTeamId(channel.teamId),
        teamName: channel.team.name,
        defaultThreadId: parseThreadId(thread.id),
        unreadCount: 0,
        lastMessageAt: lastMessageAt ?? null,
        createdAt: channel.createdAt.toISOString(),
        updatedAt: channel.updatedAt.toISOString(),
      },
      instance: null,
      thread: ThreadRecordSchema.parse({
        id: parseThreadId(thread.id),
        channelId: parseChannelId(thread.channelId),
        title: thread.title ?? 'General',
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      }),
      ...(agent ? { configSummary: buildPersonalAssistantConfigSummary(agent) } : {}),
    })
  }

  const isAgentVisibleToUser = (
    userId: string,
    organizationId: string,
    agentId: string,
  ): Promise<boolean> =>
    isAgentVisibleToUserShared(prisma, userId, organizationId, agentId)

  const isAgentAccessibleToActor = (
    actorContext: AuthorizedActionContext,
    agentId: string,
  ): Promise<boolean> =>
    isAgentAccessibleToActorShared(prisma, actorContext, agentId)

  const getVisibleChannel = async (
    userId: string,
    organizationId: string,
    channelId: string,
  ): Promise<{
    systemChannelType?: ChannelSystemType
    type: string
    visibility: string
  } | null> => {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        systemChannelType: true,
        type: true,
        organizationId: true,
        visibility: true,
        members: { where: { userId }, select: { id: true }, take: 1 },
      },
    })
    if (!channel) return null
    if (channel.organizationId !== organizationId) return null
    // Public channels are visible to all org members
    if (channel.visibility === 'public') {
      return {
        systemChannelType: channel.systemChannelType ?? undefined,
        type: channel.type,
        visibility: channel.visibility,
      }
    }
    // Protected and private channels require membership
    if (channel.members.length > 0) {
      return {
        systemChannelType: channel.systemChannelType ?? undefined,
        type: channel.type,
        visibility: channel.visibility,
      }
    }
    return null
  }

  const isChannelMember = async (userId: string, channelId: string): Promise<boolean> =>
    (await prisma.channelMember.count({ where: { userId, channelId } })) > 0

  const getChannelIfMember = (
    userId: string,
    organizationId: string,
    channelId: string,
  ) => getChannelIfMemberShared(prisma, userId, organizationId, channelId)

  const isWorkflowInstallationAccessibleToActor = async (
    actorContext: AuthorizedActionContext,
    workflowInstallationId: string,
  ): Promise<boolean> =>
    (await prisma.workflowInstallation.count({
      where: {
        id: workflowInstallationId,
        organizationId: actorContext.tenant.organizationId,
      },
    })) > 0

  const isTriggerTargetWritableByActor = async (
    actorContext: AuthorizedActionContext,
    trigger: {
      targetChannelId?: string
      workflowInstallationId?: string
    },
  ): Promise<boolean> => {
    if (actorContext.actor.roles?.includes('owner')) {
      return true
    }

    if (trigger.workflowInstallationId) {
      return false
    }

    if (actorContext.actor.actorType !== 'user' || !trigger.targetChannelId) {
      return false
    }

    if (
      !(await getVisibleChannel(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        trigger.targetChannelId,
      ))
    ) {
      return false
    }

    return isChannelMember(actorContext.actor.actorId, trigger.targetChannelId)
  }

  const isTriggerAccessibleToActor = async (
    actorContext: AuthorizedActionContext,
    trigger: { agentId?: string; workflowInstallationId?: string },
  ): Promise<boolean> => {
    if (trigger.agentId) {
      return isAgentAccessibleToActor(actorContext, trigger.agentId)
    }
    if (trigger.workflowInstallationId) {
      return isWorkflowInstallationAccessibleToActor(
        actorContext,
        trigger.workflowInstallationId,
      )
    }
    return false
  }

  const canAccessChannelRealtimeEvent = async (input: {
    channelId: string
    organizationId: string
    userId: string
  }): Promise<boolean> =>
    (await getVisibleChannel(input.userId, input.organizationId, input.channelId)) !== null

  const createAgentVisibilityScope = (actorContext: AuthorizedActionContext) => ({
    includeAllOrgChannels: actorContext.actor.roles?.includes('owner') ?? false,
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
  })

  const filterAuthorizedScopes = async (
    userId: string,
    tenantOrganizationId: string,
    scopes: WsScope[],
  ): Promise<WsScope[]> => {
    const authorizedScopes: WsScope[] = []

    for (const scope of scopes) {
      if (scope.kind === 'organization') {
        if (scope.organizationId === parseOrganizationId(tenantOrganizationId)) {
          authorizedScopes.push(scope)
        }
        continue
      }

      if (scope.kind === 'channel') {
        if (await getVisibleChannel(userId, tenantOrganizationId, scope.channelId)) {
          authorizedScopes.push(scope)
        }
        continue
      }

      if (scope.kind === 'user') {
        if (
          scope.userId === parseUserId(userId)
          && scope.organizationId === parseOrganizationId(tenantOrganizationId)
        ) {
          authorizedScopes.push(scope)
        }
        continue
      }

      if (await isAgentVisibleToUser(userId, tenantOrganizationId, scope.agentId)) {
        authorizedScopes.push(scope)
      }
    }

    return authorizedScopes
  }

  // Project read access: an org owner sees every project in their org;
  // everyone else only projects they are an explicit ProjectMember of. This is
  // what keeps one team's tickets, board and iterations off another team's
  // screen — org scope alone made them readable by every member.
  //
  // The predicate itself lives in `@nessie/workspace-admin` so the worker's
  // `project_list` tool asks exactly this question; these wrappers only unpack
  // the actor context.
  const projectViewer = (actorContext: AuthorizedActionContext) => ({
    isOwner: actorContext.actor.roles?.includes('owner') === true,
    organizationId: actorContext.tenant.organizationId,
    userId: actorContext.actor.actorId,
  })

  const isProjectAccessibleToActor = async (
    actorContext: AuthorizedActionContext,
    projectId: string,
  ): Promise<boolean> =>
    isProjectAccessibleToUser(prisma, projectViewer(actorContext), projectId)

  // `'all'` for owners (no project filter at all), otherwise the id list of the
  // projects the actor belongs to.
  const listAccessibleProjectIds = async (
    actorContext: AuthorizedActionContext,
  ): Promise<string[] | 'all'> =>
    listAccessibleProjectIdsShared(prisma, projectViewer(actorContext))

  return {
    isPersonalAssistantChannelType,
    isDelegatedSystemDmChannelType,
    buildChannelRealtimeScopes,
    loadPersonalAssistantState,
    isAgentAccessibleToActor,
    isProjectAccessibleToActor,
    listAccessibleProjectIds,
    getVisibleChannel,
    getChannelIfMember,
    isWorkflowInstallationAccessibleToActor,
    isTriggerTargetWritableByActor,
    isTriggerAccessibleToActor,
    canAccessChannelRealtimeEvent,
    createAgentVisibilityScope,
    filterAuthorizedScopes,
  }
}
