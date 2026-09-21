import { type OrchestratorDecision, type PgRealtimeTransport } from '@nessie/runtime'
import {
  type OrchestrateDecideJobPayload, parseAgentId, parseRunId,
  type AuthorizedActionContext,
  parseTaskId, parseThreadId, withActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { ChannelDecisionPolicyError, resolveChannelPolicyAuthorizer } from '@nessie/team-admin'
import { enqueueRunExecution } from '../queue.js'
import { isDelegatedSystemDmChannelType } from './delegated-identity.js'
import { claimThreadRunOrPend } from './thread-serialization.js'
import { acknowledgeDecision, logReplyDecision, publishReplyRunStarted } from './orchestrate-publications.js'
import { runActorContextForCandidate } from './orchestrate-candidates.js'
import { postOrchestrationNotice } from './orchestration-notice.js'
import { ensureChannelPolicyKickoff } from './orchestrate-kickoff.js'

const isSingleAgentSystemDm = isDelegatedSystemDmChannelType

/** Applies decisions through the existing reaction and serialized run write paths. */
export const dispatchOrchestratorDecisions = async (
  deps: { prisma: PrismaClient; realtimeTransport: PgRealtimeTransport },
  payload: OrchestrateDecideJobPayload,
  channel: { systemChannelType: string | null; visibility?: string },
  decisions: OrchestratorDecision[],
  policyAuthorizer: AuthorizedActionContext | null = null,
): Promise<void> => {
  const { actorContext, channelAgents, channelId, content, messageId, role, threadId } = payload
  const channelOnly = isSingleAgentSystemDm(channel.systemChannelType)
    || (channel.visibility !== undefined && channel.visibility !== 'public')
  const scopes =
    channelOnly
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
    const isPolicyWork = decision.action === 'reply' && decision.policyWork === true
    let runActorContext = runActorContextForCandidate(actorContext, candidate)
    if (isPolicyWork) {
      try {
        runActorContext = await resolveChannelPolicyAuthorizer(deps.prisma, {
          authorizer: policyAuthorizer,
          channelId, organizationId: actorContext.tenant.organizationId,
          target: { agentId: candidate.id, principalUserId: candidate.principalUserId },
        })
      } catch (error) {
        if (!(error instanceof ChannelDecisionPolicyError)) throw error
        await postOrchestrationNotice(deps, {
          agentId: candidate.id, channelId, threadId, triggerMessageId: messageId,
          kind: 'decision_unavailable', principalUserId: candidate.principalUserId,
          replyRootMessageId: messageId,
          content: 'The configured follow-up could not run because its saved authorization is no longer valid. '
            + 'A channel manager can review and save the agent decisions in Channel settings.',
        })
        continue
      }
    }

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
        const triggerMessageId = isPolicyWork
          ? await ensureChannelPolicyKickoff(tx, payload, decision) : messageId
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
            interactive: !isPolicyWork && actorContext.actor.actorType === 'user',
            messageId: triggerMessageId,
            ...(decision.promptOverride ? { promptOverride: decision.promptOverride } : {}),
            ...(decision.replyPlacement ? { replyPlacement: decision.replyPlacement } : {}),
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
            triggerMessageId,
            // Pre-run reply-placement judgement (model-made, or structural for
            // @mentions/PA DMs). Null keeps the historical threaded default.
            replyPlacement: decision.replyPlacement ?? null,
            promptOverride: decision.promptOverride ?? null,
          },
          select: { agentId: true, id: true, status: true, threadId: true },
        })

        const createdTask = await tx.task.create({
          data: {
            runId: createdRun.id,
            agentId: decision.agentId,
            organizationId: actorContext.tenant.organizationId,
            status: 'inbox',
            purpose: isPolicyWork ? 'Channel decision follow-up' : content.slice(0, 200),
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
            interactive: !isPolicyWork && actorContext.actor.actorType === 'user',
            ...(decision.promptOverride ? { promptOverride: decision.promptOverride } : {}),
            messageId: triggerMessageId,
            runId: parseRunId(createdRun.id),
            taskId: parseTaskId(createdTask.id),
            threadId: parseThreadId(createdRun.threadId),
          },
          // Deterministic key: if this job retries (e.g., publishWs fails after
          // the transaction commits), a second run.create produces a new run.id.
          // Using messageId+agentId prevents the duplicate run.execute from being
          // enqueued, so the agent does not reply twice even if a second run row
          // is created as an orphan.
          `run:${triggerMessageId}:${decision.agentId}:${candidate.principalUserId ?? 'ordinary'}`,
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

      // Publish after commit: pg_notify cannot roll back, but the run/task now
      // exist durably, so the live event cannot point at an orphan.
      if (!isPolicyWork) await publishReplyRunStarted({
        channelId,
        content,
        isSingleAgentSystemDm: channelOnly,
        messageId,
        realtimeTransport: deps.realtimeTransport,
        role,
        run,
        scopes,
      })
      logReplyDecision(messageId, run, task.id, threadId)
    }

    if (decision.action === 'acknowledge') {
      await acknowledgeDecision({
        candidate,
        decision,
        messageId,
        prisma: deps.prisma,
        realtimeTransport: deps.realtimeTransport,
        scopes,
        threadId,
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
