import {
  attributionFromActorContext,
  CREDITS_EXHAUSTED_USER_MESSAGE,
  checkBudget,
  decideAgentEngagement,
  isCreditsExhaustedError,
  DecisionInputLimitError,
  resolveMentionedAgentDecisions,
  type OrchestratorDecision,
  type PgRealtimeTransport,
  type ModelClient,
  type DecisionModelClient,
} from '@nessie/runtime'
import {
  type AgentMention,
  type AuthorizedActionContext,
  type OrchestrateDecideJobPayload,
  ChannelDecisionPolicySchema,
  DEFAULT_CHANNEL_DECISION_POLICY,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { dispatchOrchestratorDecisions } from './orchestrate-dispatch.js'
import { isDelegatedSystemDmChannelType } from './delegated-identity.js'
import { loadOrchestrationContext } from './orchestrate-context.js'
import {
  answerInMainChat,
  decideOneOnOneTurn,
  isOneOnOneAgentRoom,
  isSinglePersonRoom,
} from './orchestrate-one-on-one.js'
import { evaluateChannelPolicy } from './orchestrate-policy.js'
import { postOrchestrationNotice } from './orchestration-notice.js'
import {
  asEngagementCandidate,
  engagementIdFor,
  type ChannelAgent,
} from './orchestrate-candidates.js'

export { runActorContextForCandidate } from './orchestrate-candidates.js'

export type OrchestrateDecideDeps = {
  modelClient: ModelClient
  decisionClient?: DecisionModelClient
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
}

/**
 * The single-agent system DMs: the Personal Assistant's, and a global agent's
 * per-user home. Each has exactly one member and exactly one server-managed
 * binding, both database facts, so there is no engagement judgement to make.
 */
export const isSingleAgentSystemDm = (
  systemChannelType: string | null,
): boolean => isDelegatedSystemDmChannelType(systemChannelType)

// A single-agent system DM has exactly one server-managed agent binding. Its
// replies are not an engagement judgement: every human turn is addressed to
// that agent. Keeping this structural route out of the model-driven
// orchestrator prevents a missing provider credential from making the DM go
// silent before the actual assistant run can report the problem. Keyed on the
// channel type alone — never on what a message says.
export const resolveSystemDmDecisions = (
  systemChannelType: string | null,
  role: string,
  channelAgents: ChannelAgent[],
): OrchestratorDecision[] | null => {
  if (!isSingleAgentSystemDm(systemChannelType)) {
    return null
  }

  const assistant = channelAgents[0]
  if (role !== 'user' || !assistant) {
    return []
  }

  // Structural, like the @mention fast path: every turn in one of these DMs is
  // addressed to its one agent. One person and one agent leave nobody to keep
  // the exchange apart from, so the answer goes to the main chat; a turn
  // written inside a reply thread still continues there, because
  // `resolveReplyRootMessageId` decides that before any placement.
  return [{ action: 'reply', agentId: assistant.id, replyPlacement: 'channel' }]
}

/**
 * A conversation thread is a structural address, exactly as a single-agent
 * system DM is.
 *
 * `threads.agent_id` names the agent a conversation is *with*
 * (docs/plans/2026-09-08-agent-conversations.md), so a top-level human turn
 * inside one engages that agent the way a turn in its DM does — no engagement
 * judgement, no model call, and therefore no way for a conversation to be
 * started empty and then go unanswered. Other bound agents still engage when
 * the person explicitly addressed them, which is why the composer's structured
 * mentions are composed in through the very resolver the ordinary path uses
 * (`resolveMentionedAgentDecisions`) rather than a second one written here.
 *
 * Keyed on structure alone, never on content:
 * - `thread.agentId` — a column;
 * - `role === 'user'` — the same anti-loop bound `decideAgentEngagement` states
 *   and `docs/standards/global-agents.md` relies on: an agent-authored turn in
 *   a conversation engages nobody, so two agents cannot talk each other in a
 *   circle inside one;
 * - a top-level trigger — a message inside a *reply* thread is a side
 *   discussion and keeps today's behaviour;
 * - the agent still being bound to the room — if it was unbound since, this
 *   returns `null` and the model-driven path decides, exactly as it would for
 *   any other room.
 *
 * The order of the first three is the rule, not a formality. The role bound
 * comes before the top-level one because it is about *who wrote this*, not
 * about where it sits: an agent-authored reply inside a conversation must
 * engage nobody, and asking "is this top-level?" first let exactly that turn
 * fall through to the model-judged path, which is free to answer it and close
 * the loop the bound exists to open.
 */
export const resolveConversationDecisions = (input: {
  agentMentions?: AgentMention[] | undefined
  channelAgents: ChannelAgent[]
  isTopLevelTrigger: boolean
  role: string
  thread: { agentId: string | null; startedByUserId: string | null } | null
}): OrchestratorDecision[] | null => {
  const conversationAgentId = input.thread?.agentId
  if (!conversationAgentId) {
    return null
  }
  if (input.role !== 'user') {
    return []
  }
  if (!input.isTopLevelTrigger) {
    return null
  }

  // A Personal Assistant presence in a shared room is one Agent row per member,
  // so the conversation's own presence is the one belonging to whoever started
  // it. An ordinary binding carries no principal and matches directly.
  const bound = input.channelAgents.filter((agent) => agent.id === conversationAgentId)
  const conversationAgent =
    bound.find(
      (agent) =>
        agent.principalUserId !== undefined
        && agent.principalUserId === input.thread?.startedByUserId,
    )
    ?? bound.find((agent) => agent.principalUserId === undefined)
  if (!conversationAgent) {
    return null
  }

  const owner: OrchestratorDecision = {
    action: 'reply',
    agentId: conversationAgent.id,
    ...(conversationAgent.principalUserId
      ? { principalUserId: conversationAgent.principalUserId }
      : {}),
    replyPlacement: 'thread',
  }
  const ownerEngagementId = engagementIdFor(conversationAgent)
  const mentioned = resolveMentionedAgentDecisions(
    input.channelAgents.map(asEngagementCandidate),
    input.agentMentions,
  ).filter((decision) => {
    if (decision.action !== 'reply') return true
    const engagementId = decision.principalUserId
      ? `${decision.agentId}:${decision.principalUserId}`
      : decision.agentId
    return engagementId !== ownerEngagementId
  })

  return [owner, ...mentioned]
}

export const executeOrchestrateDecideJob = async (
  deps: OrchestrateDecideDeps,
  payload: OrchestrateDecideJobPayload,
): Promise<void> => {
  const {
    actorContext,
    agentMentions,
    channelAgents,
    channelId,
    messageId,
    role,
    threadId,
  } = payload
  const channel = await deps.prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      organizationId: true,
      systemChannelType: true,
      type: true,
      visibility: true,
      decisionPolicy: true,
      decisionPolicyAuthorizer: true,
      archivedAt: true,
      deletedAt: true,
      // Who is in the room decides where its answers go: a DM whose only
      // member is the person talking has nobody else for a thread to spare.
      _count: { select: { members: true } },
    },
  })

  // Belt-and-suspenders guard — API already checks before enqueueing.
  if (channelAgents.length === 0 || !channel || channel.archivedAt || channel.deletedAt) {
    return
  }

  // Reply-thread placement (#233): the trigger message's reply-thread root
  // (the message itself when it is a top-level root) scopes both the budget
  // notice and thread-following below. When the trigger cannot be fetched,
  // both keep their previous whole-thread behaviour.
  // The thread's own conversation identity rides on this same read rather than
  // a third query: the trigger message already has to be fetched for reply
  // placement, and `Thread.agentId` / `Thread.startedByUserId` are two columns
  // on the row it already joins.
  const triggerMessage = await deps.prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      role: true,
      rootMessageId: true,
      createdAt: true,
      threadId: true,
      channelDecision: true,
      basisScopes: { select: { scopeType: true, scopeId: true } },
      thread: { select: { agentId: true, startedByUserId: true } },
    },
  })
  if ((triggerMessage?.role ?? role) !== 'user') return
  const parsedPolicy = ChannelDecisionPolicySchema.safeParse(channel.decisionPolicy)
  const policy = parsedPolicy.success ? parsedPolicy.data : DEFAULT_CHANNEL_DECISION_POLICY
  const usePolicy = channel.type === 'standard'
    && (policy.enabled || triggerMessage?.channelDecision != null)
  const replyRootContextId = triggerMessage
    ? triggerMessage.rootMessageId ?? triggerMessage.id
    : undefined

  // Budget gate: the orchestrator decision below is itself a model call, so it must
  // be gated here as well as at run execution. When over budget, post a single
  // notice and skip the decision entirely rather than spend on it.
  const budgetDecision = await checkBudget(
    deps.prisma,
    {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
    },
    { isHuman: actorContext.actor.actorType === 'user' },
  )
  // Only a hard block stops the decision; degrade/allow proceed (the reply run is
  // where the cheaper model is actually applied).
  if (budgetDecision.action === 'block') {
    const respondingAgent = channelAgents[0]
    if (respondingAgent) {
      await postOrchestrationNotice(deps, {
        agentId: respondingAgent.id,
        channelId,
        content: `⚠️ ${budgetDecision.reason} — this request was not run.`,
        kind: 'budget_blocked',
        principalUserId: respondingAgent.principalUserId,
        replyRootMessageId: replyRootContextId,
        threadId,
        triggerMessageId: messageId,
      })
    }
    console.warn(`[worker] orchestrate.decide blocked by budget (channel ${channelId}): ${budgetDecision.reason}`)
    return
  }

  let policyAuthorizer: AuthorizedActionContext | null = null
  const room = {
    memberCount: channel._count?.members ?? 0,
    systemChannelType: channel.systemChannelType,
    type: channel.type,
  }
  const topLevelTrigger = triggerMessage ? triggerMessage.rootMessageId === null : false
  // One person and one agent: Jev decides how the agent answers — a reply, the
  // work done and marked, or a reaction — and whether the message goes back to
  // an earlier one. Null means there is no judgement to act on, and the room
  // answers the way it always has, below.
  let decisions = triggerMessage && isOneOnOneAgentRoom(room, channelAgents)
    ? await decideOneOnOneTurn(deps, {
      agent: channelAgents[0]!,
      channel,
      payload,
      trigger: triggerMessage,
    })
    : null
  const judgedOneOnOne = decisions !== null
  decisions ??= resolveSystemDmDecisions(
    channel.systemChannelType,
    role,
    channelAgents,
  )
  // The sibling structural rule: a conversation thread addresses its own agent.
  // Only consulted when the DM rule declined, so a conversation inside a
  // single-agent system DM keeps that DM's already-structural answer.
  // The thread the conversation branch reads is the trigger's own, read from
  // the row rather than taken from the payload. The payload is server-written,
  // so this is consistency between two reads of the same send, not a trust
  // boundary: a mismatch means the branch would be deciding about one thread
  // from another thread's columns, and the model-judged path is the answer.
  const triggerInConversationThread =
    triggerMessage !== null && triggerMessage.threadId === threadId
  decisions ??= resolveConversationDecisions({
    agentMentions,
    channelAgents,
    // A message inside a reply thread is a side discussion; it keeps today's
    // behaviour whatever the containing thread is.
    isTopLevelTrigger: triggerMessage ? triggerMessage.rootMessageId === null : false,
    // The persisted role, not the payload's: the anti-loop bound is about who
    // actually wrote the row.
    role: triggerMessage?.role ?? role,
    thread: triggerInConversationThread ? triggerMessage.thread : null,
  })
  if (!decisions || usePolicy) {
    const structuralDecisions = decisions
      ?? (agentMentions?.length ? resolveMentionedAgentDecisions(channelAgents, agentMentions) : null)
    const decisionContext = await loadOrchestrationContext(
      deps, payload, channel, replyRootContextId, usePolicy, triggerMessage?.createdAt,
    )
    try {
      if (usePolicy) {
        const evaluated = await evaluateChannelPolicy(deps, {
          payload, policy, authorizer: channel.decisionPolicyAuthorizer,
          snapshot: triggerMessage?.channelDecision,
          structuralDecisions, context: decisionContext,
          restrictedTrigger: (triggerMessage?.basisScopes?.length ?? 0) > 0,
        })
        decisions = evaluated.decisions
        policyAuthorizer = evaluated.authorizer
      } else decisions = await decideAgentEngagement(deps.modelClient, {
        // channelAgents from the payload is structurally identical to OrchestratorAgent[].
        // The Zod schema shape and the type both require { id, name, role, systemPrompt }.
        agents: channelAgents.map(asEngagementCandidate),
        agentMentions,
        ...decisionContext,
        ...(deps.decisionClient ? { decisionClient: deps.decisionClient } : {}),
        triggerIsHuman: role === 'user',
        usage: attributionFromActorContext(actorContext, {
          systemComponent: 'orchestrator',
        }),
      })
    } catch (error) {
      // `decideAgentEngagement` already fail-opens every generic model error.
      // The only error it rethrows is Ledger's typed exhausted-credit refusal,
      // which must be visible even though no run exists to terminalize.
      const creditsExhausted = isCreditsExhaustedError(error)
      if (!creditsExhausted && !usePolicy) throw error
      const respondingAgent = channelAgents[0]
      if (respondingAgent) {
        await postOrchestrationNotice(deps, {
          agentId: respondingAgent.id,
          channelId,
          content: error instanceof DecisionInputLimitError
            ? 'This message and the channel decision policy exceed Jev’s input limits. '
              + 'Shorten the channel guidance, reduce its decision options, or address an agent directly.'
            : creditsExhausted
            ? `⚠️ ${CREDITS_EXHAUSTED_USER_MESSAGE} — automatic channel decisions could not run.`
            : 'Automatic channel decisions are unavailable. Check Ledger evaluation access in this installation. '
              + 'You can still address an agent directly.',
          kind: creditsExhausted ? 'credits_exhausted' : 'decision_unavailable',
          principalUserId: respondingAgent.principalUserId,
          replyRootMessageId: replyRootContextId,
          threadId,
          triggerMessageId: messageId,
        })
      }
      console.warn(`[worker] orchestrate.decide unavailable (channel ${channelId})`)
      // Classifier failure never erases a structural address. There is no
      // speculative fallback for policy work; the ordinary run reports its own failures.
      if (!usePolicy || !structuralDecisions?.length) return
      decisions = structuralDecisions
    }
  }

  if (decisions.length === 0) {
    return
  }
  if (!judgedOneOnOne && topLevelTrigger && isSinglePersonRoom(room)) {
    decisions = answerInMainChat(decisions)
  }

  await dispatchOrchestratorDecisions(deps, payload, channel, decisions, policyAuthorizer)
}
