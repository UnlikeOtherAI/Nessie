import type { PrismaClient } from '@prisma/client'
import {
  fingerprintMcpToolDescriptor,
  isCurrentAllowedMcpToolGrant,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'
import {
  AppConnectionRequestConsentSnapshotSchema,
  AppSetupCardPresenterSchema,
  type AppSetupCardPresenter,
  type AuthorizedActionContext,
} from '@nessie/schemas'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

type ProjectedTool = {
  description: string
  id: string
  inputSchema: unknown
  metadata: unknown
  outputSchema: unknown
  toolId: string
  transportConfig: unknown
}

const descriptorName = (entry: Pick<ProjectedTool, 'toolId' | 'transportConfig'>): string | null => {
  const configured = record(entry.transportConfig).toolName
  if (typeof configured === 'string' && configured.length > 0) return configured
  const separator = entry.toolId.lastIndexOf(':')
  return separator >= 0 && separator < entry.toolId.length - 1
    ? entry.toolId.slice(separator + 1)
    : null
}

const toolIsAvailableToAssistant = (
  entry: ProjectedTool,
  toolPolicy: unknown,
  grants: readonly { config: unknown; state: string; toolId: string }[],
): boolean => {
  if (record(entry.metadata).requiresExplicitGrant !== true) {
    return record(toolPolicy)[entry.id] !== false
  }
  const name = descriptorName(entry)
  if (!name) return false
  const fingerprint = fingerprintMcpToolDescriptor({
    annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
    description: entry.description,
    inputSchema: entry.inputSchema,
    name,
    outputSchema: entry.outputSchema,
  })
  return grants.some((grant) =>
    grant.toolId === entry.id
    && isCurrentAllowedMcpToolGrant(grant, fingerprint))
}

/**
 * Viewer-safe projection of a conversational app request.
 *
 * The card message deliberately contains only the request pointer. This
 * service is the sole reader that turns that pointer into presentable state,
 * so a different member cannot learn who authenticated an account, which
 * connection backs it, or an OAuth URL by loading an old message.
 */
export const getAppConnectionRequestPresenter = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  requestId: string,
): Promise<AppSetupCardPresenter | null> => {
  if (actorContext.actor.actorType !== 'user') return null

  const organizationId = actorContext.tenant.organizationId
  const userId = actorContext.actor.actorId
  const request = await prisma.agentAppConnectionRequest.findFirst({
    where: {
      id: requestId,
      organizationId,
      requestedByUserId: userId,
    },
    select: {
      agent: {
        select: {
          agentKind: true,
          bindings: { select: { channelId: true } },
          id: true,
          systemManaged: true,
          toolPolicy: true,
        },
      },
      agentId: true,
      candidateCatalogEntryIds: true,
      consentSnapshot: true,
      expiresAt: true,
      failureCode: true,
      id: true,
      mcpInstance: {
        select: {
          lifecycleState: true,
          toolRegistryEntries: {
            where: { enabled: true, status: 'active' },
            select: {
              description: true,
              id: true,
              inputSchema: true,
              metadata: true,
              outputSchema: true,
              toolId: true,
              transportConfig: true,
            },
          },
        },
      },
      organization: { select: { conversationalSetupEnabled: true } },
      requestedByUser: {
        select: {
          organizationMembers: {
            where: { organizationId, deactivatedAt: null },
            select: { id: true },
          },
        },
      },
      selectedCatalogEntryId: true,
      status: true,
      thread: {
        select: {
          channel: {
            select: {
              dmKey: true,
              id: true,
              members: { select: { userId: true } },
              systemChannelType: true,
            },
          },
        },
      },
    },
  })

  if (!request || request.organization.conversationalSetupEnabled !== true) return null
  if (request.requestedByUser.organizationMembers.length !== 1) return null

  const snapshot = AppConnectionRequestConsentSnapshotSchema.safeParse(request.consentSnapshot)
  if (!snapshot.success || snapshot.data.agent.id !== request.agentId) return null
  if (
    snapshot.data.candidates.length !== request.candidateCatalogEntryIds.length
    || snapshot.data.candidates.some(
      (candidate, index) => candidate.catalogEntryId !== request.candidateCatalogEntryIds[index],
    )
  ) {
    return null
  }

  const channel = request.thread.channel
  const isExactPersonalAssistantConversation =
    channel.systemChannelType === 'personal_assistant'
    && channel.dmKey === `pa:${organizationId}:${userId}`
    && channel.members.length === 1
    && channel.members[0]?.userId === userId
    && request.agent.id === request.agentId
    && request.agent.agentKind === 'personal_assistant'
    && request.agent.systemManaged
    && request.agent.bindings.some((binding) => binding.channelId === channel.id)
  if (!isExactPersonalAssistantConversation) return null

  const projectedTools = request.mcpInstance?.toolRegistryEntries ?? []
  const grants = projectedTools.length === 0
    ? []
    : await prisma.toolGrant.findMany({
        where: {
          agentId: request.agentId,
          roleId: null,
          toolId: { in: projectedTools.map((tool) => tool.id) },
        },
        select: { config: true, state: true, toolId: true },
      })
  const assistantCanUseConnectedApp = projectedTools.some((tool) =>
    toolIsAvailableToAssistant(tool, request.agent.toolPolicy, grants))
  const expired = request.expiresAt.getTime() <= Date.now()
  const completedConnectionStatus = request.mcpInstance?.lifecycleState === 'active'
    ? projectedTools.length === 0 || assistantCanUseConnectedApp
      ? 'ready'
      : 'awaiting_grant'
    : request.mcpInstance?.lifecycleState === 'error'
      ? 'failed'
      : null
  const status = expired && request.status === 'offered'
    ? 'expired'
    : completedConnectionStatus
      && ['connecting', 'awaiting_grant', 'ready'].includes(request.status)
      ? completedConnectionStatus
      : request.status
  const detail = status === 'ready' && projectedTools.length === 0
    ? 'Connected, but this app did not expose any capabilities for the assistant to use.'
    : status === 'awaiting_grant'
      ? 'Connected, but Personal Assistant access is switched off in App Management.'
      : null
  const action = status === 'offered' ? 'begin' : 'none'

  return AppSetupCardPresenterSchema.parse({
    action,
    agent: snapshot.data.agent,
    candidates: snapshot.data.candidates,
    detail,
    expiresAt: request.expiresAt.toISOString(),
    failureCode: status === 'failed' ? request.failureCode ?? 'CONNECTION_FAILED' : request.failureCode,
    requestId: request.id,
    scope: {
      label: snapshot.data.scope.label,
      scopeType: snapshot.data.scope.scopeType,
    },
    selectedCatalogEntryId: request.selectedCatalogEntryId,
    status,
  })
}
