import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  AppConnectionRequestConsentSnapshotSchema,
  AppConnectRequestToolInputSchema,
  AppConnectRequestToolOutputSchema,
  AppSearchToolInputSchema,
  AppSearchToolOutputSchema,
  AppSetupCardSchema,
  type AppStoreSafePresentation,
  type AppSummaryRecord,
} from '@nessie/schemas'
import {
  listStoreApps,
  presentAppSummary,
  STORE_CATALOG_SELECT,
  storeCatalogWhere,
  type StoreCatalogRow,
} from '@nessie/mcp-manage'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId, resolveActingMember } from './access.js'

const OFFER_COOLDOWN_MS = 60_000
const OFFER_EXPIRY_MS = 30 * 60_000
// A request that has begun OAuth or is awaiting an App Management decision
// owns a live connection attempt. A later conversational offer must not hide
// it behind a new card while its external flow is still in progress.
export const SUPERSEDABLE_APP_CONNECTION_REQUEST_STATUSES = [
  'offered',
  'needs_secret',
  'selecting_resources',
  'awaiting_scope_upgrade',
] as const

type LiveMember = {
  role: string
  userId: string
}

const requireConversationalSetup = async (
  context: BuiltinToolRuntimeContext,
): Promise<void> => {
  const organization = await context.prisma.organization.findUnique({
    where: { id: context.channel.organizationId },
    select: { conversationalSetupEnabled: true },
  })
  if (organization?.conversationalSetupEnabled !== true) {
    throw new Error('Conversational app setup is not enabled for this organisation.')
  }
}

const toSafePresentation = (
  app: Pick<
    AppSummaryRecord,
    'authMethod' | 'displayName' | 'iconUrl' | 'id' | 'shortDescription' | 'toolCount' | 'trustLevel'
  >,
): AppStoreSafePresentation => ({
  authMethod: app.authMethod,
  capabilityCount: app.toolCount,
  catalogEntryId: app.id,
  displayName: app.displayName,
  iconUrl: app.iconUrl,
  shortDescription: app.shortDescription,
  trustLevel: app.trustLevel,
})

const presentCandidate = (row: StoreCatalogRow): AppStoreSafePresentation =>
  toSafePresentation(presentAppSummary(row, {
    connectionStatuses: [],
    serverUnreachable: false,
  }))

const requirePersonalAssistantOfferContext = (
  context: BuiltinToolRuntimeContext,
): string => {
  const userId = requireActingUserId(context)
  if (
    context.agentKind !== 'personal_assistant'
    || context.channel.systemChannelType !== 'personal_assistant'
    || context.run.interactive !== true
    || context.run.originatingUserId !== userId
  ) {
    throw new Error(
      'App connection requests are available only in the requesting user’s live Personal Assistant conversation.',
    )
  }
  return userId
}

const requireUniqueCandidates = (candidateCatalogEntryIds: readonly string[]): void => {
  if (new Set(candidateCatalogEntryIds).size !== candidateCatalogEntryIds.length) {
    throw new Error('Each app choice must be different.')
  }
}

const resolveLiveOfferContext = async (
  tx: Prisma.TransactionClient,
  context: BuiltinToolRuntimeContext,
  userId: string,
): Promise<LiveMember> => {
  const [organization, membership, channel, agent] = await Promise.all([
    tx.organization.findUnique({
      where: { id: context.channel.organizationId },
      select: { conversationalSetupEnabled: true },
    }),
    tx.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: context.channel.organizationId,
          userId,
        },
      },
      select: { deactivatedAt: true, role: true },
    }),
    tx.channel.findFirst({
      where: {
        dmKey: `pa:${context.channel.organizationId}:${userId}`,
        id: context.channel.id,
        organizationId: context.channel.organizationId,
        systemChannelType: 'personal_assistant',
        members: { some: { userId } },
      },
      select: { members: { select: { userId: true } } },
    }),
    tx.agent.findFirst({
      where: {
        agentKind: 'personal_assistant',
        bindings: { some: { channelId: context.channel.id } },
        id: context.agentId,
        organizationId: context.channel.organizationId,
        systemManaged: true,
      },
      select: { id: true },
    }),
  ])

  if (organization?.conversationalSetupEnabled !== true) {
    throw new Error('Conversational app setup is not enabled for this organisation.')
  }
  if (!membership || membership.deactivatedAt) {
    throw new Error('Your access to this organisation is not active, so I cannot offer an app connection.')
  }
  if (!channel || channel.members.length !== 1 || channel.members[0]?.userId !== userId || !agent) {
    throw new Error('App connection requests are available only in your Personal Assistant conversation.')
  }
  return { role: membership.role, userId }
}

const loadVisibleCandidates = async (
  tx: Prisma.TransactionClient,
  context: BuiltinToolRuntimeContext,
  member: LiveMember,
  candidateCatalogEntryIds: readonly string[],
): Promise<AppStoreSafePresentation[]> => {
  const actorContext = {
    ...context.actorContext,
    actor: {
      ...context.actorContext.actor,
      actorId: member.userId,
      actorType: 'user' as const,
      roles: [member.role],
    },
  }
  const rows = await tx.mcpCatalogEntry.findMany({
    where: {
      AND: [
        storeCatalogWhere(actorContext),
        {
          id: { in: [...candidateCatalogEntryIds] },
          locked: false,
          status: { not: 'deprecated' },
        },
      ],
    },
    select: STORE_CATALOG_SELECT,
  })
  const byId = new Map(rows.map((row) => [row.id, presentCandidate(row)]))
  const candidates = candidateCatalogEntryIds.flatMap((id) => {
    const candidate = byId.get(id)
    return candidate ? [candidate] : []
  })
  if (candidates.length !== candidateCatalogEntryIds.length) {
    throw new Error('One or more selected Apps are no longer available to you.')
  }
  return candidates
}

export const runAppSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AppSearchToolInputSchema.parse(input)
  await requireConversationalSetup(context)
  const member = await resolveActingMember(context)
  const result = await listStoreApps(context.prisma, member.actorContext, { query: args.query })
  const output = AppSearchToolOutputSchema.parse({
    apps: result.apps.slice(0, args.limit ?? 5).map(toSafePresentation),
  })
  return {
    inputSummary: `query=${JSON.stringify(args.query)} limit=${args.limit ?? 5}`,
    outputPreview: JSON.stringify(output),
    toolName: 'app_search',
  }
}

export const runAppConnectRequestTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AppConnectRequestToolInputSchema.parse(input)
  requireUniqueCandidates(args.candidateCatalogEntryIds)
  const userId = requirePersonalAssistantOfferContext(context)
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }
  await requireConversationalSetup(context)
  await resolveActingMember(context)

  const requestId = randomUUID()
  const result = await context.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`app-connect:${userId}:${context.agentId}:${context.run.threadId}`}, 0)
      )
    `
    const member = await resolveLiveOfferContext(tx, context, userId)
    const candidates = await loadVisibleCandidates(
      tx,
      context,
      member,
      args.candidateCatalogEntryIds,
    )
    const now = new Date()
    const activeRequest = await tx.agentAppConnectionRequest.findFirst({
      where: {
        agentId: context.agentId,
        requestedByUserId: userId,
        status: { in: [...SUPERSEDABLE_APP_CONNECTION_REQUEST_STATUSES] },
        threadId: context.run.threadId,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, offerCooldownUntil: true },
    })
    if (activeRequest && activeRequest.offerCooldownUntil > now) {
      return { kind: 'existing' as const }
    }
    if (activeRequest) {
      await tx.agentAppConnectionRequest.update({
        where: { id: activeRequest.id },
        data: { completedAt: now, status: 'superseded' },
      })
    }

    const snapshot = AppConnectionRequestConsentSnapshotSchema.parse({
      agent: { id: context.agentId, name: runContext.agent.name },
      candidates,
      scope: { label: 'Only you', scopeId: userId, scopeType: 'user' },
    })
    const card = AppSetupCardSchema.parse({
      card: { kind: 'app_connect_request', requestId, schemaVersion: 1 },
    })
    const message = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content: 'Choose an app to connect in the card below.',
      metadata: card as Prisma.InputJsonValue,
      role: 'assistant',
      threadId: context.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })
    await tx.agentAppConnectionRequest.create({
      data: {
        agentId: context.agentId,
        candidateCatalogEntryIds: [...args.candidateCatalogEntryIds],
        consentSnapshot: snapshot as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + OFFER_EXPIRY_MS),
        id: requestId,
        messageId: message.id,
        offerCooldownUntil: new Date(now.getTime() + OFFER_COOLDOWN_MS),
        organizationId: context.channel.organizationId,
        originRunId: context.run.id,
        originTriggerMessageId: context.run.messageId,
        requestedByUserId: userId,
        scopeId: userId,
        scopeType: 'user',
        threadId: context.run.threadId,
      },
    })
    return { kind: 'created' as const, message }
  })

  if (result.kind === 'created') {
    const reply = runContext.replyRootMessageId
      ? await applyRunReplyBookkeeping(
        context.prisma,
        runContext,
        result.message.createdAt,
      )
      : undefined
    await publishMessageCreated(context.realtimeTransport, runContext, {
      content: result.message.content,
      messageId: result.message.id,
      role: 'assistant',
      ...(result.message.basis.length > 0 ? { restricted: true } : {}),
      ...(reply ? { reply } : {}),
    })
  }

  const output = AppConnectRequestToolOutputSchema.parse({ status: 'offered' })
  return {
    inputSummary: `candidates=${args.candidateCatalogEntryIds.length}`,
    outputPreview: JSON.stringify(output),
    toolName: 'app_connect_request',
  }
}
