import {
  applyReplyBookkeeping,
  attributionFromActorContext,
  checkBudget,
  decideAgentEngagement,
  partitionByDisclosure,
  resolveDisclosureViewer,
  selectFollowingAgentIds,
  type OrchestratorAgent,
  type OrchestratorDecision,
  type PgRealtimeTransport,
  type ModelClient,
} from '@nessie/runtime'
import {
  type OrchestrateDecideJobPayload,
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { enqueueRunExecution } from '../queue.js'
import { describeAttachments, loadMessageAttachments } from './message-attachments.js'
import { claimThreadRunOrPend } from './thread-serialization.js'

export type OrchestrateDecideDeps = {
  modelClient: ModelClient
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
}

type ChannelAgent = OrchestratorAgent & { principalUserId?: string }

const engagementIdFor = (agent: ChannelAgent): string =>
  agent.principalUserId ? `${agent.id}:${agent.principalUserId}` : agent.id

const asEngagementCandidate = (agent: ChannelAgent): OrchestratorAgent =>
  agent.principalUserId
    ? { ...agent, engagementId: engagementIdFor(agent) }
    : agent

// The original poster starts the engagement, but a shared PA presence acts
// only as its own principal. Keep this at the orchestration boundary so run,
// tool, memory, and ledger consumers all receive the same effective identity.
export const runActorContextForCandidate = (
  actorContext: OrchestrateDecideJobPayload['actorContext'],
  candidate: ChannelAgent,
) =>
  candidate.principalUserId
    ? withActionContext(actorContext, {
        effectiveUserId: parseUserId(candidate.principalUserId),
      })
    : actorContext

// A personal-assistant DM has exactly one server-managed agent binding. Its
// replies are not an engagement judgement: every human turn is addressed to
// that agent. Keeping this structural route out of the model-driven
// orchestrator prevents a missing provider credential from making the DM go
// silent before the actual assistant run can report the problem.
export const resolvePersonalAssistantDecisions = (
  systemChannelType: string | null,
  role: string,
  channelAgents: ChannelAgent[],
): OrchestratorDecision[] | null => {
  if (systemChannelType !== 'personal_assistant') {
    return null
  }

  const assistant = channelAgents[0]
  if (role !== 'user' || !assistant) {
    return []
  }

  // Structural, like the @mention fast path: every turn in a PA DM is addressed
  // to this one assistant, so its answer belongs to that exchange.
  return [{ action: 'reply', agentId: assistant.id, replyPlacement: 'thread' }]
}

export const executeOrchestrateDecideJob = async (
  deps: OrchestrateDecideDeps,
  payload: OrchestrateDecideJobPayload,
): Promise<void> => {
  const { actorContext, channelAgents, channelId, content, messageId, role, threadId } = payload
  const channel = await deps.prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      organizationId: true,
      systemChannelType: true,
    },
  })

  // Belt-and-suspenders guard — API already checks before enqueueing.
  if (channelAgents.length === 0 || !channel) {
    return
  }

  // Reply-thread placement (#233): the trigger message's reply-thread root
  // (the message itself when it is a top-level root) scopes both the budget
  // notice and thread-following below. When the trigger cannot be fetched,
  // both keep their previous whole-thread behaviour.
  const triggerMessage = await deps.prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, rootMessageId: true },
  })
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
      const notice = await deps.prisma.message.create({
        data: {
          agentId: respondingAgent.id,
          content: `⚠️ ${budgetDecision.reason} — this request was not run.`,
          ...(respondingAgent.principalUserId
            ? { onBehalfOfUserId: respondingAgent.principalUserId }
            : {}),
          role: 'assistant',
          threadId,
          ...(replyRootContextId ? { rootMessageId: replyRootContextId } : {}),
        },
      })
      const replyMeta = replyRootContextId
        ? await applyReplyBookkeeping(deps.prisma, {
            rootMessageId: replyRootContextId,
            replyCreatedAt: notice.createdAt,
            authorId: respondingAgent.id,
          })
        : undefined
      const noticeScopes = [{ kind: 'channel' as const, channelId }]
      if (replyMeta && replyRootContextId) {
        await deps.realtimeTransport.publishWs(noticeScopes, {
          data: {
            agentId: parseAgentId(respondingAgent.id),
            channelId,
            contentPreview: notice.content.slice(0, 200),
            messageId: notice.id,
            role: 'assistant',
            rootMessageId: replyRootContextId,
            threadId: parseThreadId(threadId),
          },
          event: 'message.reply',
        })
        await deps.realtimeTransport.publishWs(noticeScopes, {
          data: {
            channelId,
            threadId: parseThreadId(threadId),
            rootMessageId: replyRootContextId,
            replyCount: replyMeta.replyCount,
            lastReplyAt: replyMeta.lastReplyAt?.toISOString(),
            replyParticipantIds: replyMeta.replyParticipantIds,
          },
          event: 'message.reply.meta',
        })
      } else {
        await deps.realtimeTransport.publishWs(noticeScopes, {
          data: {
            agentId: parseAgentId(respondingAgent.id),
            channelId,
            contentPreview: notice.content.slice(0, 200),
            messageId: notice.id,
            role: 'assistant',
            threadId: parseThreadId(threadId),
          },
          event: 'message.new',
        })
      }
    }
    console.warn(`[worker] orchestrate.decide blocked by budget (channel ${channelId}): ${budgetDecision.reason}`)
    return
  }

  let decisions = resolvePersonalAssistantDecisions(
    channel.systemChannelType,
    role,
    channelAgents,
  )
  if (!decisions) {
    // Fetch the last 6 messages for orchestrator context. The most recent one
    // is the triggering message (already persisted before this job was enqueued).
    // After .reverse(), it sits at the end; .slice(0, -1) removes it so the LLM
    // sees only prior conversation history.
    const recentDbMessages = await deps.prisma.message.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: {
        agent: { select: { name: true } },
        basisScopes: { select: { scopeType: true, scopeId: true } },
      },
    })

    // The window the *run* reads is disclosure-filtered (`prompt.ts`); this one
    // was not, so the engagement judgement for one person's message could be
    // formed over another person's restricted exchange. It decides only whether
    // and where to reply, but a judgement is still a reading, and the two
    // windows disagreeing about what exists is its own defect. Withheld turns
    // are dropped rather than placeheld: there is no reader here to show a
    // placeholder to.
    const viewer = await resolveDisclosureViewer(
      deps.prisma,
      channel.organizationId,
      actorContext.actionContext.effectiveUserId
        ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : undefined),
    )
    const recentOrdered = partitionByDisclosure(recentDbMessages, viewer).visible.reverse()
    // A message can be nothing but a photo. Naming its files gives the
    // engagement judgement something to read — without an inventory line an
    // image-only post looks like an empty message and nobody answers it.
    const attachments = await loadMessageAttachments(
      deps.prisma,
      channel.organizationId,
      [...recentOrdered.map((m) => m.id), messageId],
    )
    const annotate = (messageContent: string, id: string): string => {
      const note = describeAttachments(attachments.get(id) ?? [])
      if (!note) return messageContent
      return messageContent.trim() ? `${messageContent}\n${note}` : note
    }

    const recentMessages = recentOrdered
      .slice(0, -1)
      .map((m) => ({
        role: m.role,
        content: annotate(m.content, m.id),
        agentName: m.agent?.name ?? undefined,
      }))

    // Thread-following remains local to the reply thread when one is active.
    const triggerIsHuman = role === 'user'
    let followingAgentIds: string[] = []
    if (triggerIsHuman) {
      const candidateAgentIds = channelAgents.map((agent) => agent.id)
      const authored = await deps.prisma.message.findMany({
        where: {
          threadId,
          role: 'assistant',
          agentId: { in: candidateAgentIds },
          ...(replyRootContextId
            ? { OR: [{ rootMessageId: replyRootContextId }, { id: replyRootContextId }] }
            : {}),
        },
        distinct: ['agentId', 'onBehalfOfUserId'],
        select: { agentId: true, onBehalfOfUserId: true },
      })
      followingAgentIds = selectFollowingAgentIds(
        candidateAgentIds,
        authored.flatMap((message) => {
          if (!message.agentId) return []
          const candidate = channelAgents.find(
            (agent) =>
              agent.id === message.agentId
              && (agent.principalUserId ?? null) === message.onBehalfOfUserId,
          )
          return candidate ? [engagementIdFor(candidate)] : []
        }),
      )
    }

    decisions = await decideAgentEngagement(deps.modelClient, {
      // channelAgents from the payload is structurally identical to OrchestratorAgent[].
      // The Zod schema shape and the type both require { id, name, role, systemPrompt }.
      agents: channelAgents.map(asEngagementCandidate),
      content: annotate(content, messageId),
      recentMessages,
      triggerIsHuman,
      followingAgentIds,
      usage: attributionFromActorContext(actorContext, {
        systemComponent: 'orchestrator',
      }),
    })
  }

  if (decisions.length === 0) {
    return
  }

  const scopes =
    channel.systemChannelType === 'personal_assistant'
      ? [
          {
            kind: 'channel' as const,
            channelId,
          },
        ]
      : [
          {
            kind: 'organization' as const,
            organizationId: actorContext.tenant.organizationId,
          },
          {
            kind: 'channel' as const,
            // channelId is already ChannelId-branded from the payload schema — no re-parse needed.
            channelId,
          },
        ]

  for (const decision of decisions) {
    if (decision.action === 'none') continue
    const candidate = channelAgents.find(
      (agent) =>
        agent.id === decision.agentId
        && (agent.principalUserId ?? undefined) === decision.principalUserId,
    )
    // A stale or malformed decision cannot turn an agent id into a different
    // member's PA. Decisions are accepted only for the exact binding candidate
    // that entered this job.
    if (!candidate) continue
    const runActorContext = runActorContextForCandidate(actorContext, candidate)

    if (decision.action === 'reply') {
      // Per-(agent, thread) serialization: claim the run slot inside this
      // transaction. If a run is already in flight, the message is recorded as
      // a durable pending marker and delivered in the batched follow-up run
      // the completion path enqueues — no concurrent run is spawned. The queue
      // is at-least-once: a redelivery of THIS decide job (already committed)
      // comes back as 'duplicate' and no-ops, so the message is never replied
      // to twice.
      const outcome = await deps.prisma.$transaction(
        async (tx): Promise<
          | { kind: 'pended' }
          | { kind: 'duplicate' }
          | {
              kind: 'claimed'
              run: { agentId: string; id: string; status: string; threadId: string }
              task: { id: string }
            }
        > => {
        const claim = await claimThreadRunOrPend(tx, {
          agentId: decision.agentId,
          ...(candidate.principalUserId
            ? { principalUserId: candidate.principalUserId }
            : {}),
          threadId,
          pending: {
            actorContext: runActorContext,
            channelId,
            // Same rule as the run payload below: a live human chat turn is
            // interactive, an agent-authored trigger is automation.
            interactive: actorContext.actor.actorType === 'user',
            messageId,
          },
        })
        if (claim !== 'claimed') {
          return claim === 'pended' ? { kind: 'pended' as const } : { kind: 'duplicate' as const }
        }

        // Wrap run + task creation and job enqueueing in a transaction.
        // If any step fails the whole unit rolls back, leaving no orphaned run
        // for the retry to trip over.
        const createdRun = await tx.run.create({
          data: {
            agentId: decision.agentId,
            principalUserId: candidate.principalUserId ?? null,
            // threadId is ThreadId-branded; Prisma's generated types accept branded strings
            // because the brand is a compile-time-only structural extension of string.
            threadId,
            status: 'pending',
            // Backlink to the user message that started this run. Enables the
            // cancel handoff-guard and restart replay (see api/src/services/runs.ts).
            triggerMessageId: messageId,
            // Pre-run reply-placement judgement (model-made, or structural for
            // @mentions/PA DMs). Null keeps the historical threaded default.
            replyPlacement: decision.replyPlacement ?? null,
          },
          select: { agentId: true, id: true, status: true, threadId: true },
        })

        const createdTask = await tx.task.create({
          data: {
            runId: createdRun.id,
            agentId: decision.agentId,
            organizationId: actorContext.tenant.organizationId,
            status: 'inbox',
            purpose: content.slice(0, 200),
          },
          select: { id: true },
        })

        await enqueueRunExecution(
          tx,
          {
            actorContext: withActionContext(runActorContext, {
              // run.agentId and run.threadId are plain strings from Prisma — parse needed.
              agentId: parseAgentId(createdRun.agentId),
              channelId,
              taskId: parseTaskId(createdTask.id),
              threadId: parseThreadId(createdRun.threadId),
            }),
            agentId: parseAgentId(createdRun.agentId),
            ...(candidate.principalUserId
              ? { principalUserId: candidate.principalUserId }
              : {}),
            // A reply to a human chat message is a live interactive turn; an agent
            // posting in a channel is automation. Drives budget human-exemption.
            interactive: actorContext.actor.actorType === 'user',
            messageId,
            runId: parseRunId(createdRun.id),
            taskId: parseTaskId(createdTask.id),
            threadId: parseThreadId(createdRun.threadId),
          },
          // Deterministic key: if this job retries (e.g., publishWs fails after
          // the transaction commits), a second run.create produces a new run.id.
          // Using messageId+agentId prevents the duplicate run.execute from being
          // enqueued, so the agent does not reply twice even if a second run row
          // is created as an orphan.
          `run:${messageId}:${decision.agentId}:${candidate.principalUserId ?? 'ordinary'}`,
        )

        return { kind: 'claimed' as const, run: createdRun, task: createdTask }
      })

      if (outcome.kind === 'pended') {
        console.log(
          JSON.stringify({
            event: 'orchestrate.pended',
            agentId: decision.agentId,
            messageId,
            threadId,
          }),
        )
        continue
      }
      if (outcome.kind === 'duplicate') {
        // At-least-once redelivery of a decide job that already committed:
        // the run (or pending marker) for this exact message exists, so this
        // delivery must not reply again.
        console.log(
          JSON.stringify({
            event: 'orchestrate.duplicate',
            agentId: decision.agentId,
            messageId,
            threadId,
          }),
        )
        continue
      }
      const { run, task } = outcome

      // Publish outside the transaction — pg_notify cannot be rolled back, but
      // the run/task are now durably committed so the event is correct.
      const publishScopes =
        channel.systemChannelType === 'personal_assistant'
          ? scopes
          : [
              ...scopes,
              { kind: 'agent' as const, agentId: parseAgentId(run.agentId) },
            ]

      await deps.realtimeTransport.publishWs(
        publishScopes,
        {
          data: {
            agentId: parseAgentId(run.agentId),
            channelId,
            contentPreview: content.slice(0, 200),
            messageId,
            role,
            threadId: parseThreadId(run.threadId),
          },
          event: 'message.new',
        },
      )

      console.log(
        JSON.stringify({
          event: 'orchestrate.reply',
          agentId: run.agentId,
          runId: run.id,
          taskId: task.id,
          messageId,
          threadId,
        }),
      )
    }

    if (decision.action === 'acknowledge') {
      await deps.prisma.messageReaction.createMany({
        data: [{
          messageId,
          agentId: decision.agentId,
          onBehalfOfUserId: candidate.principalUserId ?? null,
          emoji: decision.emoji,
        }],
        skipDuplicates: true,
      })

      const reactionData = {
        messageId,
        agentId: parseAgentId(decision.agentId),
        ...(candidate.principalUserId
          ? { onBehalfOfUserId: parseUserId(candidate.principalUserId) }
          : {}),
        emoji: decision.emoji,
      }

      // threadId is branded ThreadId; publishSse accepts string — brands are
      // structural subtypes of string so this is both type-safe and correct.
      await deps.realtimeTransport.publishSse(threadId, 'message.reaction', reactionData)
      await deps.realtimeTransport.publishWs(scopes, {
        data: reactionData,
        event: 'message.reaction',
      })

      console.log(
        JSON.stringify({
          event: 'orchestrate.acknowledge',
          agentId: decision.agentId,
          emoji: decision.emoji,
          messageId,
        }),
      )
    }
  }
}
