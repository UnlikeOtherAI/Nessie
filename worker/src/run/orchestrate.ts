import {
  attributionFromActorContext,
  checkBudget,
  decideAgentEngagement,
  type OrchestratorAgent,
  type PgRealtimeTransport,
  type ModelClient,
} from '@nessie/runtime'
import {
  type OrchestrateDecideJobPayload,
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { enqueueRunExecution } from '../queue.js'

export type OrchestrateDecideDeps = {
  modelClient: ModelClient
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
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
    const respondingAgentId = channelAgents[0]?.id
    if (respondingAgentId) {
      const notice = await deps.prisma.message.create({
        data: {
          agentId: respondingAgentId,
          content: `⚠️ ${budgetDecision.reason} — this request was not run.`,
          role: 'assistant',
          threadId,
        },
      })
      await deps.realtimeTransport.publishWs([{ kind: 'channel' as const, channelId }], {
        data: {
          agentId: parseAgentId(respondingAgentId),
          channelId,
          contentPreview: notice.content.slice(0, 200),
          messageId: notice.id,
          role: 'assistant',
          threadId: parseThreadId(threadId),
        },
        event: 'message.new',
      })
    }
    console.warn(`[worker] orchestrate.decide blocked by budget (channel ${channelId}): ${budgetDecision.reason}`)
    return
  }

  // Fetch the last 6 messages for orchestrator context. The most recent one
  // is the triggering message (already persisted before this job was enqueued).
  // After .reverse(), it sits at the end; .slice(0, -1) removes it so the LLM
  // sees only prior conversation history.
  const recentDbMessages = await deps.prisma.message.findMany({
    where: { threadId },
    orderBy: { createdAt: 'desc' },
    take: 6,
    include: { agent: { select: { name: true } } },
  })

  const recentMessages = recentDbMessages
    .reverse()
    .slice(0, -1)
    .map((m) => ({
      role: m.role,
      content: m.content,
      agentName: m.agent?.name ?? undefined,
    }))

  const decisions = await decideAgentEngagement(deps.modelClient, {
    // channelAgents from the payload is structurally identical to OrchestratorAgent[].
    // The Zod schema shape and the type both require { id, name, role, systemPrompt }.
    agents: channelAgents satisfies OrchestratorAgent[],
    content,
    recentMessages,
    usage: attributionFromActorContext(actorContext, {
      systemComponent: 'orchestrator',
    }),
  })

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
    if (decision.action === 'reply') {
      // Wrap run + task creation and job enqueueing in a transaction.
      // If any step fails the whole unit rolls back, leaving no orphaned run
      // for the retry to trip over.
      const { run, task } = await deps.prisma.$transaction(async (tx) => {
        const createdRun = await tx.run.create({
          data: {
            agentId: decision.agentId,
            // threadId is ThreadId-branded; Prisma's generated types accept branded strings
            // because the brand is a compile-time-only structural extension of string.
            threadId,
            status: 'pending',
            // Backlink to the user message that started this run. Enables the
            // cancel handoff-guard and restart replay (see api/src/services/runs.ts).
            triggerMessageId: messageId,
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
            actorContext: withActionContext(actorContext, {
              // run.agentId and run.threadId are plain strings from Prisma — parse needed.
              agentId: parseAgentId(createdRun.agentId),
              channelId,
              taskId: parseTaskId(createdTask.id),
              threadId: parseThreadId(createdRun.threadId),
            }),
            agentId: parseAgentId(createdRun.agentId),
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
          `run:${messageId}:${decision.agentId}`,
        )

        return { run: createdRun, task: createdTask }
      })

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
      await deps.prisma.messageReaction.upsert({
        where: {
          messageId_agentId_emoji: {
            messageId,
            agentId: decision.agentId,
            emoji: decision.emoji,
          },
        },
        update: {},
        create: {
          messageId,
          agentId: decision.agentId,
          emoji: decision.emoji,
        },
      })

      const reactionData = {
        messageId,
        agentId: parseAgentId(decision.agentId),
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
