import { markRecallsInjected } from '@nessie/memory'
import {
  attributionFromActorContext,
  BUILTIN_TOOL_DEFINITIONS,
  TODO_TOOL_DEFINITIONS,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { fileServiceFor } from '../file-service.js'
import { buildExecutorToolset, type ExecutorToolset } from '../executor-toolset.js'
import { buildMcpToolset, type McpToolset } from '../mcp-toolset.js'
import { loadAgentTodoPromptFacts } from '@nessie/workspace-admin'
import { isPersonalAssistantPresenceRun, resolveAgentTools } from '../tool-policy.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import {
  buildCheckpointInjection,
  loadRunCheckpointForRun,
  type LoadedRunCheckpoint,
} from './checkpoint.js'
import { buildMemoryContext, retrieveRelevantMemories } from './memory.js'
import { buildModelPrompt, loadConversation } from './prompt.js'
import { viewerSatisfiesBasis } from '@nessie/runtime'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import { loadAllowedToolIds } from './tool-registry.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'
import {
  hasDocumentsPromptTools,
  hasKbWriteTools,
  resolveAgentDocumentsHome,
} from './agent-documents.js'

// Everything the agentic loop needs, assembled once: the agent's toolset, its
// conversation window, retrieved memories, any checkpoint left by an earlier
// incomplete run, and the resulting model prompt.

const DELEGATE_TOOL_ID = 'delegate'
const TODO_TOOL_IDS = new Set(TODO_TOOL_DEFINITIONS.map((tool) => tool.id))

export type ResolvedRunToolset = {
  allowedIds: Set<string>
  descriptors: ToolSchemaDescriptor[]
  stubbedIds: Set<string>
  toolSpecEnabled: boolean
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
    stubbedIds: new Set(
      [...resolved.stubbedIds].filter((toolId) => toolId !== DELEGATE_TOOL_ID),
    ),
    toolSpecEnabled: resolved.toolSpecEnabled,
  }
}

/**
 * To-dos are an owner-configured agent capability, not a registry grant. Keep
 * their descriptors, resolved ids, and deferred-schema ids together so a
 * disabled agent is never offered a tool it cannot call.
 */
export const applyTodoToolExclusions = (
  resolved: ResolvedRunToolset,
  todosEnabled: boolean,
): ResolvedRunToolset => {
  if (todosEnabled) return resolved
  return {
    allowedIds: new Set(
      [...resolved.allowedIds].filter((toolId) => !TODO_TOOL_IDS.has(toolId)),
    ),
    descriptors: resolved.descriptors.filter(
      (descriptor) => !TODO_TOOL_IDS.has(descriptor.toolName),
    ),
    stubbedIds: new Set(
      [...resolved.stubbedIds].filter((toolId) => !TODO_TOOL_IDS.has(toolId)),
    ),
    toolSpecEnabled: resolved.toolSpecEnabled,
  }
}

export type RunExecutionSetup = {
  allowedToolIds: Set<string>
  /** The checkpoint this run claimed, if any — its generation seeds the next. */
  checkpoint: LoadedRunCheckpoint | null
  executorToolset: ExecutorToolset
  initialMessages: ProviderMessage[]
  mcpToolset: McpToolset
  memories: RetrievedMemory[]
  resolvedToolIds: Set<string>
  stubbedBuiltinToolIds: Set<string>
  toolDefs: ToolSchemaDescriptor[]
  toolSpecEnabled: boolean
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
    select: {
      toolPolicy: true,
      parentAgentId: true,
      todosEnabled: true,
      systemManaged: true,
      parentAgent: { select: { id: true, name: true, systemManaged: true } },
    },
  })
  const toolPolicy = agentRecord?.toolPolicy as Record<string, boolean> | null ?? null
  const {
    descriptors: toolDefs,
    allowedIds: resolvedToolIds,
    stubbedIds: stubbedBuiltinToolIds,
    toolSpecEnabled,
  } = applyHandoffToolExclusions(
    applyTodoToolExclusions(
      resolveAgentTools(
      allowedToolIds,
      BUILTIN_TOOL_DEFINITIONS,
      toolPolicy,
      context.agent.parentAgentId,
      context.agent.agentKind,
      {
        isPersonalAssistantPresence: isPersonalAssistantPresenceRun({
          agentKind: context.agent.agentKind,
          principalUserId: context.run.principalUserId,
          systemChannelType: context.channel.systemChannelType,
        }),
      },
      ),
      agentRecord?.todosEnabled ?? false,
    ),
    input.isHandoffTurn,
  )

  // A spawned child shares its parent's documents home. The PA is
  // system-managed and writes personal artifacts to its user's My Docs, so it
  // has no agent home at all.
  const documentsAgent = agentRecord?.parentAgent ?? {
    id: context.agent.id,
    name: context.agent.name,
    systemManaged: agentRecord?.systemManaged ?? false,
  }
  const documentsHome = hasKbWriteTools(resolvedToolIds) && !documentsAgent.systemManaged
    ? await resolveAgentDocumentsHome(deps.prisma, {
      agentId: documentsAgent.id,
      agentName: documentsAgent.name,
      organizationId: context.channel.organizationId,
      projectId: context.channel.projectId,
    })
    : null

  const [mcpToolset, executorToolset, todoFacts] = await Promise.all([
    buildMcpToolset(
      deps.prisma,
      context.channel.organizationId,
      toolPolicy,
      payload.actorContext,
      {
        agentId: context.agent.id,
        agentKind: context.agent.agentKind,
        channelId: context.channel.id,
        isPersonalAssistantPresence: isPersonalAssistantPresenceRun({
          agentKind: context.agent.agentKind,
          principalUserId: context.run.principalUserId,
          systemChannelType: context.channel.systemChannelType,
        }),
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
    ),
    buildExecutorToolset(deps.prisma, {
      agentId: context.agent.id,
      agentToolPolicy: toolPolicy,
      encryptionSecret: deps.executorCommandEncryptionSecret,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    }),
    (resolvedToolIds.has('todo_start') || resolvedToolIds.has('todo_template_propose'))
      ? loadAgentTodoPromptFacts(deps.prisma, {
          agentId: context.agent.id,
          organizationId: context.channel.organizationId,
        })
      : Promise.resolve(null),
  ])

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
  const loadedCheckpoint = input.isHandoffTurn
    ? null
    : await loadRunCheckpointForRun(deps.prisma, {
      rootMessageId: context.replyRootMessageId ?? null,
      runId: context.run.id,
      threadId: context.run.threadId,
    })

  // A checkpoint gets exactly the treatment the transcript gets, and for the
  // same reason: it is a carry-forward channel for another run's words. The
  // transcript withholds turns this viewer cannot read (`partitionByDisclosure`)
  // and inherits the basis of the ones it admits, so that "summarise that"
  // cannot launder a restricted turn. Without the same two halves here, "keep
  // going" did exactly that — the note carries verbatim tool output, and the
  // resumed reply computed its basis from a sink that had never seen those
  // scopes.
  //
  // Withheld: the person resuming cannot reach the sources, so the run must not
  // answer them from it. Admitted: inherit, so the continuation's own reply is
  // restricted the way the interrupted one was.
  const checkpoint = loadedCheckpoint
    && !viewerSatisfiesBasis(loadedCheckpoint.basisScopes, viewer)
    ? null
    : loadedCheckpoint
  if (checkpoint) {
    context.consumedSources.addAll(checkpoint.basisScopes)
  }

  return {
    allowedToolIds,
    checkpoint,
    executorToolset,
    initialMessages: buildModelPrompt(conversation, context, input.prompt, memoryContext, {
      checkpointNotes: checkpoint ? buildCheckpointInjection(checkpoint) : null,
      routing: {
        hasDelegate: resolvedToolIds.has('delegate'),
        hasResearchTools: mcpToolset.hasManagedResearchTools,
        hasWebSearch: resolvedToolIds.has('web_search'),
        isHandoffTurn: input.isHandoffTurn,
      },
      todoFacts,
      documents: documentsHome
        ? {
          ...documentsHome,
          hasDocumentTools: hasDocumentsPromptTools(resolvedToolIds),
        }
        : undefined,
    }),
    mcpToolset,
    memories,
    resolvedToolIds,
    stubbedBuiltinToolIds,
    toolDefs: [...toolDefs, ...executorToolset.descriptors],
    toolSpecEnabled,
    toolPolicy,
  }
}
