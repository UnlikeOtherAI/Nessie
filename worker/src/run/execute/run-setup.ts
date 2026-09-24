import { markRecallsInjected } from '@nessie/memory'
import { loadActivePersonalBrowserAccessForRun } from '@nessie/browser-cloud'
import {
  AGENT_CONVERSATIONS_LIST_TOOL_ID,
  AGENT_CONVERSATION_START_TOOL_ID,
  AGENT_HANDOFF_TOOL_ID,
  CONVERSATION_REFERENCE_TOOL_ID,
  attributionFromActorContext,
  BUILTIN_TOOL_DEFINITIONS,
  TODO_TOOL_DEFINITIONS,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import { carryForwardExecutorBindings, publishExecutorLeaseChanges } from '@nessie/executor-manage'
import { APPROVAL_ACTIONS, TICKET_WORK_PURPOSE, type RunExecuteJobPayload } from '@nessie/schemas'
import { fileServiceFor } from '../file-service.js'
import { launchConversationScope } from '../executor-host-output.js'
import { buildExecutorToolset, type ExecutorToolset } from '../executor-toolset.js'
import { buildMcpToolset, type McpToolset } from '../mcp-toolset.js'
import { loadAgentTodoPromptFacts } from '@nessie/team-admin'
import { isPersonalAssistantPresenceRun, resolveAgentTools } from '../tool-policy.js'
import {
  resolveDelegatedRequesterUserId,
  resolveIdentityDelegatedToolIds,
} from '../delegated-identity.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import {
  admitRunCheckpoint,
  buildCheckpointInjection,
  loadRunCheckpointForRun,
  type LoadedRunCheckpoint,
} from './checkpoint.js'
import { buildMemoryContext, retrieveRelevantMemories } from './memory.js'
import {
  RETRIEVED_CONTEXT_TOKEN_BUDGET,
  retrieveRelevantHistory,
} from './history-recall.js'
import { estimateTokens } from '../context-management.js'
import { buildModelPrompt, loadConversation } from './prompt.js'
import { loadExecutorReachFacts } from './executor-reach-facts.js'
import { viewerSatisfiesBasis } from '@nessie/runtime'
import { resolveLiveEntitlements } from '@nessie/runtime'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import { loadEmailConversationContext } from './email-conversation-context.js'
import { loadAllowedToolIds } from './tool-registry.js'
import {
  loadTicketWorkRunFacts,
  ticketWorkRecallSkipped,
  TICKET_WORK_PERSON_TOOL_IDS,
  TICKET_WORK_PROJECT_TOOL_IDS,
  withoutEndedWorkWrites,
} from './ticket-work-setup.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext } from './types.js'
import {
  browserLoginRequestPromptTools,
  hasCardPromptTools,
} from './agent-cards-prompt.js'
import {
  hasDocumentsPromptTools,
  hasKbWriteTools,
  hasSpreadsheetPromptTools,
  resolveAgentDocumentsHome,
} from './agent-documents.js'

// Everything the agentic loop needs, assembled once: the agent's toolset, its
// conversation window, retrieved memories, any checkpoint left by an earlier
// incomplete run, and the resulting model prompt.

const DELEGATE_TOOL_ID = 'delegate'
const TODO_TOOL_IDS = new Set(TODO_TOOL_DEFINITIONS.map((tool) => tool.id))
/**
 * The project tools a shared agent may be lent in its project channel. Editing
 * or deleting a comment and removing a file stay off it: a shared agent may
 * only change what it authored, and v1 keeps those to the Personal Assistant.
 */
export const PEER_PROJECT_TOOL_IDS: ReadonlySet<string> = new Set([
  'ticket_list', 'ticket_read', 'ticket_board_read', 'ticket_board_create',
  'ticket_create', 'ticket_update', 'ticket_assign', 'ticket_move', 'ticket_transition',
  'ticket_checklist_read', 'ticket_checklist_apply', 'ticket_checklist_step_update',
  'ticket_labels_read', 'ticket_label_create', 'ticket_comment_list', 'ticket_comment_add',
  'ticket_attachment_list', 'ticket_attachment_add',
])

/**
 * Whether a run may be lent project tools at all, before the binding is
 * checked: a shared agent, in a project's channel, on a turn a real person
 * started (or a bounded durable peer request carried).
 *
 * A `ticket.work` run is decided by its own arm, first, so it can never be
 * admitted through the person-started arms below: it acts as the agent with
 * no person behind it, whatever its actor context says. It is admitted when a
 * shared agent works a ticket of this channel's own project — the work record
 * run setup re-read (`ticketWorkProjectId`) — and the caller still checks the
 * agent's live binding here (docs/standards/ticket-work.md → "A `ticket.work`
 * run acts as the agent").
 */
export const isProjectDelegatedRun = (run: {
  agentKind: string
  channelProjectId: string | null
  actorType: string
  interactive: boolean
  purpose?: string | null
  /** The project of the work record a `ticket.work` run serves; null when none matched. */
  ticketWorkProjectId?: string | null
}): boolean => {
  if (run.purpose === TICKET_WORK_PURPOSE) {
    return run.agentKind === 'shared'
      && run.channelProjectId !== null
      && run.ticketWorkProjectId === run.channelProjectId
  }
  return run.agentKind === 'shared'
    && run.channelProjectId !== null
    && run.actorType === 'user'
    && (run.interactive || run.purpose === 'agent.peer_delegation' || run.purpose === 'channel.policy')
}

/**
 * The project tools admitted for this run: none unless the run is a real
 * project delegation, and then only the peer set's tools the agent's policy
 * explicitly grants — for a `ticket.work` run, only those with an agent task
 * actor (`TICKET_WORK_PROJECT_TOOL_IDS`). Pure, so the admission can be pinned
 * without a run.
 */
export const resolveProjectDelegatedToolIds = (
  projectDelegation: boolean,
  toolPolicy: Record<string, boolean> | null,
  ticketWork = false,
): Set<string> => new Set(
  projectDelegation
    ? BUILTIN_TOOL_DEFINITIONS
      .filter(
        (tool) =>
          PEER_PROJECT_TOOL_IDS.has(tool.id)
          && (!ticketWork || TICKET_WORK_PROJECT_TOOL_IDS.has(tool.id))
          && tool.projectDelegatedOnly
          && toolPolicy?.[tool.id] === true,
      )
      .map((tool) => tool.id)
    : [],
)

/**
 * Whether the run was offered a lent project tool that writes — the fact
 * memory recall narrows on (`requiresProjectWriteRecallContainment`).
 * Structural: a lent, offered id whose definition is not `safe`.
 */
export const holdsProjectWriteTools = (
  projectDelegatedToolIds: ReadonlySet<string>,
  resolvedToolIds: ReadonlySet<string>,
): boolean => BUILTIN_TOOL_DEFINITIONS.some(
  (tool) => !tool.safe && projectDelegatedToolIds.has(tool.id) && resolvedToolIds.has(tool.id),
)

/**
 * Tools this run withholds whatever its policy grants, so the model is never
 * shown a tool it cannot call: `delegate` on a DeepWater launch turn (the
 * handoff guard refuses the call, so result delivery cannot hide inside a
 * sub-agent), and the to-do builtins on an agent whose owner has to-dos off (an
 * owner-configured capability, not a registry grant).
 *
 * Handed to `resolveAgentTools` rather than filtered out of its result: the
 * deferred view promotes an agent's explicit grants up to a budget and offers
 * `tool_spec` only while something is a stub, so a tool removed after the view
 * was built had already spent that budget — pushing a real grant back to a
 * stub — and could leave `tool_spec` offered with nothing to look up.
 */
export const resolveWithheldRunToolIds = (input: {
  isHandoffTurn: boolean
  todosEnabled: boolean
  /** A `ticket.work` run: never the tools that act for a person (`ticket-work-setup.ts`). */
  ticketWork?: boolean
}): ReadonlySet<string> => new Set([
  ...(input.isHandoffTurn ? [DELEGATE_TOOL_ID] : []),
  ...(input.todosEnabled ? [] : TODO_TOOL_IDS),
  ...(input.ticketWork ? TICKET_WORK_PERSON_TOOL_IDS : []),
])

export type RunExecutionSetup = {
  allowedToolIds: Set<string>
  /** The checkpoint this run claimed, if any — its generation seeds the next. */
  checkpoint: LoadedRunCheckpoint | null
  /**
   * `personalAssistantOnly` tool ids this run's global-agent blueprint may
   * exercise (D3). Empty for every ordinary run, including the PA's — it passes
   * on its own `agentKind` arm. Carried on the setup so the per-call gate in
   * `authorizeToolExecution` judges the exact set toolset assembly offered.
   */
  identityToolIds: ReadonlySet<string>
  projectDelegatedToolIds: ReadonlySet<string>
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
      projectId: true,
      todosEnabled: true,
      systemManaged: true,
      parentAgent: { select: { id: true, name: true, projectId: true, systemManaged: true } },
    },
  })
  const toolPolicy = agentRecord?.toolPolicy as Record<string, boolean> | null ?? null
  const ticketWorkRun = payload.actorContext.actionContext.purpose === TICKET_WORK_PURPOSE
  const ticketWork = await loadTicketWorkRunFacts(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    threadId: context.run.threadId,
  })
  // Ordinary shared agents may receive project tools only when a real person
  // initiated this project-channel run (or a bounded durable peer request did),
  // the agent remains bound there, and its policy explicitly grants each tool.
  const projectDelegation = isProjectDelegatedRun({
    agentKind: context.agent.agentKind,
    channelProjectId: context.channel.projectId,
    actorType: payload.actorContext.actor.actorType,
    interactive: payload.interactive === true,
    purpose: payload.actorContext.actionContext.purpose,
    ticketWorkProjectId: ticketWork?.projectId ?? null,
  })
    && (await deps.prisma.agentBinding.count({
      where: { agentId: context.agent.id, channelId: context.channel.id },
    })) > 0
  const projectDelegatedToolIds = withoutEndedWorkWrites(
    resolveProjectDelegatedToolIds(projectDelegation, toolPolicy, ticketWorkRun),
    ticketWork,
  )

  // D3: the one place the identity-tool admission is decided. Both the schema
  // array below and the per-call gate downstream consume this same set, so a
  // stale schema cannot be exercised and a tool is never offered-then-denied.
  const identityToolIds = resolveIdentityDelegatedToolIds(
    {
      agentKind: context.agent.agentKind,
      dmKey: context.channel.dmKey,
      organizationId: context.channel.organizationId,
      systemChannelType: context.channel.systemChannelType,
      systemSlug: context.agent.systemSlug,
    },
    resolveDelegatedRequesterUserId({
      actorId: payload.actorContext.actor.actorId,
      actorType: payload.actorContext.actor.actorType,
      effectiveUserId: payload.actorContext.actionContext.effectiveUserId,
      interactive: payload.interactive === true,
    }),
  )

  const {
    descriptors: toolDefs,
    allowedIds: resolvedToolIds,
    stubbedIds: stubbedBuiltinToolIds,
    toolSpecEnabled,
  } = resolveAgentTools(
    allowedToolIds,
    BUILTIN_TOOL_DEFINITIONS,
    toolPolicy,
    context.agent.parentAgentId,
    context.agent.agentKind,
    {
      // Structural loop bound for `agent_handoff` (D8): a global agent's row
      // carries a slug, and the tool is omitted from its schema array rather
      // than offered and denied.
      agentSystemSlug: context.agent.systemSlug ?? null,
      identityToolIds,
      projectDelegatedToolIds,
      isPersonalAssistantPresence: isPersonalAssistantPresenceRun({
        agentKind: context.agent.agentKind,
        principalUserId: context.run.principalUserId,
        systemChannelType: context.channel.systemChannelType,
      }),
      withheldToolIds: resolveWithheldRunToolIds({
        isHandoffTurn: input.isHandoffTurn,
        todosEnabled: agentRecord?.todosEnabled ?? false,
        ticketWork: ticketWorkRun,
      }),
    },
  )

  // A spawned child shares its parent's documents home. The PA is
  // system-managed and writes personal artifacts to its user's My Docs, so it
  // has no agent home at all.
  const documentsAgent = agentRecord?.parentAgent ?? {
    id: context.agent.id,
    name: context.agent.name,
    projectId: agentRecord?.projectId ?? null,
    systemManaged: agentRecord?.systemManaged ?? false,
  }
  const documentsHome = hasDocumentsPromptTools(resolvedToolIds)
    && !documentsAgent.systemManaged
    ? await resolveAgentDocumentsHome(deps.prisma, {
      agentId: documentsAgent.id,
      agentName: documentsAgent.name,
      organizationId: context.channel.organizationId,
      projectId: documentsAgent.projectId,
    })
    : null

  // A person launched local apps in this run's own conversation: the launch
  // itself, or a lease carried from it, which only ever carries within the
  // conversation the launch opened. What the machine answers — a program's
  // output, a coding session's title in the reach facts — is shown there.
  const hostOutput = { launchScope: launchConversationScope(context.channel.id), sink: context.consumedSources }
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
        consumedSources: context.consumedSources,
        deepWaterHandoffGuard: input.deepWaterHandoffGuard,
        ledgerIdentity: deps.ledgerIdentity,
        secretResolver: deps.mcpSecrets?.resolver,
      },
    ),
    (async () => {
      // A person's own follow-up in the conversation they launched local apps
      // in is bound afresh here, immediately before the toolset reads the
      // run's bindings. A refusal is an outcome, never a throw — and the carry
      // runs for every agent's every turn, so an unexpected failure in it (a
      // lost connection) must not sink an ordinary one either: the run goes on
      // with whatever bindings it already has, and no reach facts are told.
      const lease = await carryForwardExecutorBindings(deps.prisma, { job: payload, runId: context.run.id })
        .catch((error: unknown) => {
          console.warn('[worker] executor lease carry failed for run', context.run.id, error)
          return undefined
        })
      context.executorLease = lease
      if (lease?.kind === 'carried') {
        // The carry moved the idle window the holder's composer shows. Only
        // the holder's own job carries, so the job's actor is the recipient.
        await publishExecutorLeaseChanges(deps.realtimeTransport, [{
          actorUserId: payload.actorContext.actor.actorId,
          id: lease.lease.id,
          organizationId: context.channel.organizationId,
          threadId: payload.threadId,
        }]).catch((error: unknown) => {
          console.warn('[worker] could not publish the executor lease notice for run', context.run.id, error)
        })
      }
      return buildExecutorToolset(deps.prisma, {
        agentId: context.agent.id,
        agentToolPolicy: toolPolicy,
        encryptionSecret: deps.executorCommandEncryptionSecret,
        hostOutput,
        organizationId: context.channel.organizationId,
        runId: context.run.id,
      })
    })(),
    (resolvedToolIds.has('todo_start') || resolvedToolIds.has('todo_template_propose'))
      ? loadAgentTodoPromptFacts(deps.prisma, {
          agentId: context.agent.id,
          organizationId: context.channel.organizationId,
        })
      : Promise.resolve(null),
  ])
  // Read from the toolset the model actually holds, so "bound" is never said
  // of an operation the toolset dropped. A DeepWater handoff turn keeps its
  // server-authored prompt byte-identical, as it does for the checkpoint.
  const executorReach = input.isHandoffTurn ? null : await loadExecutorReachFacts(deps.prisma, {
    agentId: context.agent.id,
    channelId: context.channel.id,
    hostOutput,
    lease: context.executorLease,
    organizationId: context.channel.organizationId,
    personUserId: payload.actorContext.actor.actorType === 'user' ? payload.actorContext.actor.actorId : null,
    runId: context.run.id,
    toolNames: executorToolset.handledNames,
  })

  const effectiveUserId =
    payload.actorContext.actionContext.effectiveUserId
    ?? (payload.actorContext.actor.actorType === 'user'
      ? payload.actorContext.actor.actorId
      : undefined)
  const liveEntitlements = effectiveUserId
    ? await resolveLiveEntitlements(deps.prisma, {
      organizationId: context.channel.organizationId,
      uoaIdentity: payload.actorContext.actionContext.uoaIdentity,
      userId: effectiveUserId,
    })
    : undefined
  const viewer = await resolveDisclosureViewer(
    deps.prisma,
    payload,
    context.channel.organizationId,
    liveEntitlements,
  )
  const conversation = await loadConversation(deps.prisma, {
    consumedSources: context.consumedSources,
    files: fileServiceFor(deps.prisma),
    organizationId: context.channel.organizationId,
    rootMessageId: context.conversationRootMessageId,
    threadId: context.run.threadId,
    ...(ticketWorkRun ? { ticketWorkAgentId: context.agent.id } : {}),
    viewer,
  })
  // Every kickoff is built from the ticket: the run has read its project, so
  // what it writes outside that project's audience carries the project's basis.
  if (ticketWork) context.consumedSources.add({ scopeId: ticketWork.projectId, scopeType: 'project' })
  // Mail is not a Message row, so a run woken by email would otherwise see only
  // the one-line reference. This is also where its disclosure scope is fed.
  const emailContext =
    context.emailConversationId && context.emailMailboxId
      ? await loadEmailConversationContext(deps.prisma, {
        agentId: context.agent.id,
        consumedSources: context.consumedSources,
        conversationId: context.emailConversationId,
        mailboxId: context.emailMailboxId,
      })
      : null

  // A run lent a project write recalls only what every project reader already
  // has, so recalled material cannot shut its own ticket writes.
  const projectWriteRecall = holdsProjectWriteTools(projectDelegatedToolIds, resolvedToolIds)
  // A `ticket.work` run recalls nothing: its context is its kickoff and the
  // filtered window above, and recall from its own thread would bring back
  // exactly the messages that filter keeps out (`ticketWorkRecallSkipped`).
  const recall = !ticketWorkRecallSkipped(payload.actorContext)
  const memories = recall
    ? await retrieveRelevantMemories(deps, context, payload, input.prompt, liveEntitlements, {
        holdsProjectWriteTools: projectWriteRecall,
      })
    : []
  const legacyMemoryContext = buildMemoryContext(memories)
  const history = recall
    ? await retrieveRelevantHistory(deps, context, payload, {
        holdsProjectWriteTools: projectWriteRecall,
        liveEntitlements,
        prompt: input.prompt,
        tokenBudget: Math.max(0, RETRIEVED_CONTEXT_TOKEN_BUDGET - estimateTokens(legacyMemoryContext ?? '')),
        viewer,
      })
    : { context: null, messageIds: [], tokenCount: 0 }
  const injectedRecallIds = memories.flatMap((memory) =>
    memory.recallId ? [memory.recallId] : [],
  )
  const memoryContext = [legacyMemoryContext, history.context]
    .filter((value): value is string => Boolean(value))
    .join('\n\n') || null

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
  // Its note may also quote local program output, which its basis cannot say
  // (`loadCheckpointHostOutputScopes`); admitting it re-stamps that too.
  if (checkpoint) {
    await admitRunCheckpoint(deps.prisma, context.consumedSources, checkpoint)
  }

  // Tool names are structural registry ids, not model-provided prose. The
  // continuation still replans through the model, but this durable fact makes
  // it deliberately re-issue the one call the human approved.
  const approvalInstruction = payload.actorContext.approval?.approvalId
    ? await deps.prisma.approvalRequest.findFirst({
      where: {
        action: APPROVAL_ACTIONS.toolInvoke,
        id: payload.actorContext.approval.approvalId,
        organizationId: context.channel.organizationId,
        status: 'approved',
      },
      select: { toolName: true },
    }).then((approval) => approval?.toolName
      ? `A human approved your proposed ${approval.toolName} call. Re-issue it to proceed.`
      : null)
    : null

  const temporaryBrowserAccess = resolvedToolIds.has('browser_open')
    ? await loadActivePersonalBrowserAccessForRun(deps.prisma, {
      agentId: context.agent.id,
      runId: context.run.id,
      threadId: context.run.threadId,
    })
    : null

  return {
    allowedToolIds,
    checkpoint,
    identityToolIds,
    projectDelegatedToolIds,
    executorToolset,
    initialMessages: buildModelPrompt(conversation, context, input.prompt, memoryContext, {
      approvalInstruction,
      emailConversation: emailContext?.block ?? null,
      checkpointNotes: checkpoint ? buildCheckpointInjection(checkpoint) : null,
      executorReach,
      routing: {
        hasDelegate: resolvedToolIds.has('delegate'),
        hasResearchTools: mcpToolset.hasManagedResearchTools,
        hasWebSearch: resolvedToolIds.has('web_search'),
        isHandoffTurn: input.isHandoffTurn,
      },
      mailbox: {
        hasGoogleMailTools: resolvedToolIds.has('gmail_search')
          || resolvedToolIds.has('gmail_draft_create'),
        hasConnectedMailboxTools: resolvedToolIds.has('mailbox_search')
          || resolvedToolIds.has('mailbox_send'),
        hasCalendarTools: resolvedToolIds.has('calendar_events_list')
          || resolvedToolIds.has('calendar_event_create'),
        hasDelegate: resolvedToolIds.has('delegate'),
      },
      handoff: { hasHandoffTool: resolvedToolIds.has(AGENT_HANDOFF_TOOL_ID) },
      conversations: {
        hasListTool: resolvedToolIds.has(AGENT_CONVERSATIONS_LIST_TOOL_ID),
        hasReferenceTool: resolvedToolIds.has(CONVERSATION_REFERENCE_TOOL_ID),
        hasStartTool: resolvedToolIds.has(AGENT_CONVERSATION_START_TOOL_ID),
      },
      hasCardTool: hasCardPromptTools(resolvedToolIds),
      hasBrowserLoginRequestTool: browserLoginRequestPromptTools(resolvedToolIds),
      temporaryBrowserAccess,
      todoFacts,
      documents: documentsHome
        ? {
          ...documentsHome,
          hasDocumentTools: hasDocumentsPromptTools(resolvedToolIds),
          hasDocumentWriteTools: hasKbWriteTools(resolvedToolIds),
          hasSpreadsheetTools: hasSpreadsheetPromptTools(resolvedToolIds),
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
