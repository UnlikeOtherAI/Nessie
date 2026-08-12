import { markRecallsInjected } from '@nessie/memory'
import {
  attributionFromActorContext,
  BUILTIN_TOOL_DEFINITIONS,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { fileServiceFor } from '../file-service.js'
import { buildMcpToolset, type McpToolset } from '../mcp-toolset.js'
import { resolveAgentTools } from '../tool-policy.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import {
  buildCheckpointInjection,
  loadRunCheckpointForRun,
  type LoadedRunCheckpoint,
} from './checkpoint.js'
import { buildMemoryContext, retrieveRelevantMemories } from './memory.js'
import { buildModelPrompt, loadConversation } from './prompt.js'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import { loadAllowedToolIds } from './tool-registry.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'

// Everything the agentic loop needs, assembled once: the agent's toolset, its
// conversation window, retrieved memories, any checkpoint left by an earlier
// incomplete run, and the resulting model prompt.

const DELEGATE_TOOL_ID = 'delegate'

export type ResolvedRunToolset = {
  allowedIds: Set<string>
  descriptors: ToolSchemaDescriptor[]
}

/**
 * `delegate` is an ordinary builtin for agent runs, but a DeepWater launch turn
 * blocks it outright (the handoff guard refuses the call so result delivery
 * cannot hide inside a sub-agent). Withhold the schema on that turn too, so the
 * model is never shown a tool it cannot call.
 */
export const applyHandoffToolExclusions = (
  resolved: ResolvedRunToolset,
  isHandoffTurn: boolean,
): ResolvedRunToolset => {
  if (!isHandoffTurn) {
    return resolved
  }
  return {
    allowedIds: new Set(
      [...resolved.allowedIds].filter((toolId) => toolId !== DELEGATE_TOOL_ID),
    ),
    descriptors: resolved.descriptors.filter(
      (descriptor) => descriptor.toolName !== DELEGATE_TOOL_ID,
    ),
  }
}

export type RunExecutionSetup = {
  allowedToolIds: Set<string>
  /** The checkpoint this run claimed, if any — its generation seeds the next. */
  checkpoint: LoadedRunCheckpoint | null
  initialMessages: ProviderMessage[]
  mcpToolset: McpToolset
  memories: RetrievedMemory[]
  resolvedToolIds: Set<string>
  toolDefs: ToolSchemaDescriptor[]
  toolPolicy: Record<string, boolean> | null
}

export const prepareRunExecution = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    deepWaterHandoffGuard: DeepWaterHandoffGuard
    // Non-null for a DeepWater launch turn: its prompt is server-authored, so
    // no routing block and no checkpoint injection.
    isHandoffTurn: boolean
    prompt: string
  },
): Promise<RunExecutionSetup> => {
  const allowedToolIds = await loadAllowedToolIds(deps.prisma, context)

  const agentRecord = await deps.prisma.agent.findUnique({
    where: { id: context.agent.id },
    select: { toolPolicy: true, parentAgentId: true },
  })
  const toolPolicy = agentRecord?.toolPolicy as Record<string, boolean> | null ?? null
  const { descriptors: toolDefs, allowedIds: resolvedToolIds } = applyHandoffToolExclusions(
    resolveAgentTools(
      allowedToolIds,
      BUILTIN_TOOL_DEFINITIONS,
      toolPolicy,
      context.agent.parentAgentId,
      context.agent.agentKind,
    ),
    input.isHandoffTurn,
  )

  const mcpToolset = await buildMcpToolset(
    deps.prisma,
    context.channel.organizationId,
    toolPolicy,
    payload.actorContext,
    {
      agentId: context.agent.id,
      agentKind: context.agent.agentKind,
      channelId: context.channel.id,
    },
    attributionFromActorContext(payload.actorContext, {
      agentId: context.agent.id,
      agentKind: context.agent.agentKind,
      runId: context.run.id,
    }),
    {
      deepWaterHandoffGuard: input.deepWaterHandoffGuard,
      ledgerIdentity: deps.ledgerIdentity,
      secretResolver: deps.mcpSecrets?.resolver,
    },
  )

  const viewer = await resolveDisclosureViewer(
    deps.prisma,
    payload,
    context.channel.organizationId,
  )
  const conversation = await loadConversation(deps.prisma, {
    consumedSources: context.consumedSources,
    files: fileServiceFor(deps.prisma),
    organizationId: context.channel.organizationId,
    rootMessageId: context.conversationRootMessageId,
    threadId: context.run.threadId,
    viewer,
  })
  const memories = await retrieveRelevantMemories(deps, context, payload, input.prompt)
  const injectedRecallIds = memories.flatMap((memory) =>
    memory.recallId ? [memory.recallId] : [],
  )
  const memoryContext = buildMemoryContext(memories)

  if (injectedRecallIds.length > 0) {
    await markRecallsInjected(injectedRecallIds, deps.searchConfig.pool)
  }

  // Checkpoint auto-load (§5): ANY follow-up run in this thread picks up the
  // saved work state, which is what makes a plain "keep going" reply resume
  // properly. DeepWater handoff runs are excluded — their launch prompt is
  // server-authored and must stay byte-identical.
  const checkpoint = input.isHandoffTurn
    ? null
    : await loadRunCheckpointForRun(deps.prisma, {
      rootMessageId: context.replyRootMessageId ?? null,
      runId: context.run.id,
      threadId: context.run.threadId,
    })

  return {
    allowedToolIds,
    checkpoint,
    initialMessages: buildModelPrompt(conversation, context, input.prompt, memoryContext, {
      checkpointNotes: checkpoint ? buildCheckpointInjection(checkpoint) : null,
      routing: {
        hasDelegate: resolvedToolIds.has('delegate'),
        hasResearchTools: mcpToolset.hasManagedResearchTools,
        hasWebSearch: resolvedToolIds.has('web_search'),
        isHandoffTurn: input.isHandoffTurn,
      },
    }),
    mcpToolset,
    memories,
    resolvedToolIds,
    toolDefs,
    toolPolicy,
  }
}
