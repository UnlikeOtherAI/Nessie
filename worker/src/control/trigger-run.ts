import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  activeWorkspaceMatchesAttribution,
  buildTriggerPrompt,
  loadLedgerIdentitySettings,
  loadLedgerUoaIdentity,
} from '@nessie/runtime'

// Read once at startup: whether this deployment signs Ledger calls is never a
// per-request, per-organization or per-user decision.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null
import {
  type AgentTriggerType,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseRunId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
  type UoaSessionIdentity,
} from '@nessie/schemas'
import { enqueueRunExecution } from '../queue.js'
import { claimThreadRunOrPend } from '../run/thread-serialization.js'
import { recordDeliveryFailure } from './trigger-delivery-retry.js'
import { recordTriggerHealthFailure } from './trigger-health.js'
import {
  assertTriggerExecutionOriginTenant,
  resolveTriggerExecutionOrigin,
  TriggerLaunchOriginError,
} from './trigger-origin.js'

// Shared "fire a run from a trigger" primitives used by both the scheduler sweep
// and event dispatch. Kept separate from the scheduling/claim logic so the two
// callers depend on the run-queueing seam, not on each other. The workflow-
// installation variant lives in workflow-trigger-run.ts and reuses the shared
// helpers below (exported for it).

// sp-webhook: a retry attempt (driven by the delivery-retry poller) reuses an
// existing `failed` delivery row instead of creating a new one, so the
// (trigger_id, dedupe_key) uniqueness holds and backoff state accumulates.
export type RetryContext = { reuseDeliveryId?: string; retryCount?: number }

// Create the delivery for a fresh fire, or reuse+reset the row when retrying.
export const upsertDelivery = async (
  tx: Prisma.TransactionClient,
  input: {
    dedupeKey?: string
    payload: Prisma.InputJsonValue
    retry?: RetryContext
    source: string
    triggerId: string
  },
): Promise<{ id: string }> => {
  if (input.retry?.reuseDeliveryId) {
    return tx.agentTriggerDelivery.update({
      where: { id: input.retry.reuseDeliveryId },
      data: {
        payload: input.payload,
        source: input.source,
        status: 'pending',
        errorMessage: null,
      },
      select: { id: true },
    })
  }

  return tx.agentTriggerDelivery.create({
    data: {
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      source: input.source,
      status: 'pending',
      triggerId: input.triggerId,
    },
    select: { id: true },
  })
}

export const normalizePayload = (payload: unknown): Prisma.InputJsonValue => {
  if (payload === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue
  }
  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean'
  ) {
    return payload
  }
  if (Array.isArray(payload)) {
    return payload as Prisma.InputJsonValue
  }
  if (payload && typeof payload === 'object') {
    return payload as Prisma.InputJsonValue
  }
  return {}
}

const buildActorContext = (input: {
  agentId: string
  channelId: string
  effectiveUserId?: string | null
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  threadId: string
  // Omitted while the (agent, thread) slot claim is still unresolved: the
  // pending-marker path has no task, and the claimed path injects the fresh
  // task id via withActionContext once the task exists.
  taskId?: string
  source: string
  /**
   * The creator's UOA workspace, replayed from the trigger's launch origin.
   * A fire has no session, so without this the Ledger signer has no identity
   * to verify and every scheduled run fails before dispatch.
   */
  uoaIdentity?: UoaSessionIdentity
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.agentId,
    actorType: 'agent',
    roles: ['system'],
  },
  actionContext: {
    agentId: parseAgentId(input.agentId),
    channelId: parseChannelId(input.channelId),
    // When a scheduled task was created by a specific user (e.g. via the
    // schedule_task tool, including the personal assistant acting for its
    // owner), run as that user so memory scoping and "act as user" tools
    // behave the same as the original conversation.
    ...(input.effectiveUserId
      ? { effectiveUserId: parseUserId(input.effectiveUserId) }
      : {}),
    purpose: input.source,
    requestId: randomUUID(),
    ...(input.uoaIdentity ? { uoaIdentity: input.uoaIdentity } : {}),
    threadId: parseThreadId(input.threadId),
    ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    projectId: input.projectId ? parseProjectId(input.projectId) : undefined,
    teamId: input.teamId ? parseTeamId(input.teamId) : undefined,
  },
})

export const queueTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    payload: unknown
    retry?: RetryContext
    source: string
    trigger: {
      agent: {
        agentKind: 'personal_assistant' | 'shared'
        organizationId: string | null
        projectId: string | null
        teamId: string | null
      }
      agentId: string
      config?: unknown
      id: string
      targetChannelId: string
      targetThreadId: string
      type: AgentTriggerType
    }
  },
): Promise<void> => {
  // The personal assistant is its owner's delegate, so it is exempt from the
  // *binding* gate — it is not bound to channels the way a shared agent is. It
  // is NOT exempt from the membership re-check: a PA's reach is its owner's
  // reach, so if the owner has since lost access to a private target channel
  // the trigger must not fire and load that channel's conversation.
  const isPersonalAssistantTrigger =
    input.trigger.agent.agentKind === 'personal_assistant'
  const existingDelivery = input.dedupeKey
    ? await prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.trigger.id,
        },
        include: {
          run: {
            select: { id: true },
          },
        },
      })
    : null

  if (existingDelivery?.run?.id) {
    return
  }

  const thread = await prisma.thread.findUnique({
    where: { id: input.trigger.targetThreadId },
    select: {
      channel: {
        select: { organizationId: true, visibility: true },
      },
      channelId: true,
    },
  })
  if (!thread || thread.channelId !== input.trigger.targetChannelId) {
    return
  }

  if (!isPersonalAssistantTrigger) {
    const binding = await prisma.agentBinding.findFirst({
      where: {
        agentId: input.trigger.agentId,
        channelId: input.trigger.targetChannelId,
      },
      select: { id: true },
    })
    if (!binding) {
      return
    }
  }

  const content = buildTriggerPrompt({
    config: input.trigger.config,
    payload: input.payload,
    source: input.source,
    triggerType: input.trigger.type,
  })

  const normalizedPayload = normalizePayload(input.payload)
  try {
    const executionOrigin = resolveTriggerExecutionOrigin({
      agent: input.trigger.agent,
      channelOrganizationId: thread.channel.organizationId,
      config: input.trigger.config,
      triggerType: input.trigger.type,
    })
    await assertTriggerExecutionOriginTenant(prisma, executionOrigin)

    // Pre-flight the Ledger identity, so a schedule that can never sign says so
    // once on the Triggers page instead of burning a failed run every sweep.
    // Catches the three ways a captured identity goes stale: the link was
    // revoked, the user's credential epoch rotated (logout, password change,
    // deactivation), or the schedule predates identity capture entirely.
    //
    // It must ask exactly what dispatch asks. `loadLedgerUoaIdentity` checks
    // only the account link (status, subject, epoch); the header path that
    // actually signs a model call additionally requires the attributed team's
    // external UOA mapping to match the captured workspace. Checking the
    // narrower condition here let a trigger pass, create a run, and have that
    // run die at its first inference — silently, because an unattended failure
    // posts nothing. That is how one production schedule burned ~1.5 hours of
    // failed runs before its epoch drifted far enough to fail this gate too.
    if (ledgerSigningConfigured && executionOrigin.userId) {
      const identity = executionOrigin.uoaIdentity
        ? await loadLedgerUoaIdentity(prisma, {
            actorId: executionOrigin.userId,
            actorType: 'user',
            organizationId: executionOrigin.organizationId,
            uoaIdentity: executionOrigin.uoaIdentity,
            userId: executionOrigin.userId,
          })
        : null
      if (!identity) {
        throw new TriggerLaunchOriginError(
          'uoa_identity_unverifiable',
          'its saved UnlikeOtherAI identity is missing or no longer valid',
        )
      }
      // The same predicate the signing path applies, not a second copy of it.
      const workspaceMatches = await activeWorkspaceMatchesAttribution(
        prisma,
        {
          actorId: executionOrigin.userId,
          actorType: 'user',
          organizationId: executionOrigin.organizationId,
          ...(executionOrigin.teamId ? { teamId: executionOrigin.teamId } : {}),
          userId: executionOrigin.userId,
        },
        identity,
      )
      if (!workspaceMatches) {
        throw new TriggerLaunchOriginError(
          'uoa_identity_unverifiable',
          'its saved UnlikeOtherAI workspace no longer maps to its team',
        )
      }
    }

    // The saved user must still be able to reach the target channel at fire
    // time — for a shared agent's saved launcher and equally for the personal
    // assistant's owner. Losing that authorization fails closed; it must never
    // silently erase the user while retaining their immutable billing team.
    if (executionOrigin.userId && thread.channel.visibility !== 'public') {
      const membership = await prisma.channelMember.findFirst({
        where: {
          channelId: input.trigger.targetChannelId,
          userId: executionOrigin.userId,
        },
        select: { userId: true },
      })
      if (!membership) {
        throw new TriggerLaunchOriginError(
          'channel_access_lost',
          'its saved user no longer has access to the target channel',
        )
      }
    }

    await prisma.$transaction(async (tx) => {
      const delivery = await upsertDelivery(tx, {
        dedupeKey: input.dedupeKey,
        payload: normalizedPayload,
        retry: input.retry,
        source: input.source,
        triggerId: input.trigger.id,
      })

      const message = await tx.message.create({
        data: {
          // A trigger kickoff is an internal directive that drives the run, not
          // a post any human made — nobody types "A schedule trigger fired" or
          // the memory nudge appended to a saved prompt. Rendering it as a
          // `user` message attributed it to the trigger's owner, so a
          // 15-minute sweep filled its own alert channel with plumbing signed
          // by someone who never wrote it. `system` keeps the row (audit,
          // restart replay by id) while excluding it from the channel feed and
          // from future model context (see listThreadMessages /
          // loadConversation) — the same treatment the PA path already used.
          // The run still receives this content as its prompt via
          // `payload.messageId`, which does not consult role, so the payload
          // JSON stays useful to the model (webhook event data) without ever
          // being shown to a person. Provenance for humans lives on the
          // Triggers page delivery log.
          content,
          ...(isPersonalAssistantTrigger
            ? {
                metadata: {
                  delegatedByAgentId: input.trigger.agentId,
                } as Prisma.InputJsonValue,
              }
            : {}),
          role: 'system',
          threadId: input.trigger.targetThreadId,
        },
        select: { id: true },
      })

      const actorContext = buildActorContext({
        agentId: input.trigger.agentId,
        channelId: input.trigger.targetChannelId,
        effectiveUserId: executionOrigin.userId,
        organizationId: executionOrigin.organizationId,
        projectId: executionOrigin.projectId,
        source: input.source,
        teamId: executionOrigin.teamId,
        threadId: input.trigger.targetThreadId,
        ...(executionOrigin.uoaIdentity
          ? { uoaIdentity: executionOrigin.uoaIdentity }
          : {}),
      })

      // Scheduled/trigger runs respect the same per-(agent, thread) claim as
      // chat replies: with a run already in flight the kickoff message pends
      // for the batched follow-up instead of spawning a concurrent run. The
      // delivery/trigger bookkeeping below still records the fire.
      const claim = await claimThreadRunOrPend(tx, {
        agentId: input.trigger.agentId,
        threadId: input.trigger.targetThreadId,
        pending: {
          actorContext,
          channelId: input.trigger.targetChannelId,
          interactive: false,
          messageId: message.id,
          // Copied onto the batched follow-up run when this fire ends up as
          // the latest pending row at drain time.
          triggerId: input.trigger.id,
          triggerDeliveryId: delivery.id,
        },
      })

      if (claim === 'claimed') {
        const run = await tx.run.create({
          data: {
            agentId: input.trigger.agentId,
            // A trigger fire is a standalone contribution to the room, not an
            // answer owed to whoever last spoke — the definition of `channel`
            // placement. Stamped structurally from the fact that this is a
            // trigger run, never judged from content. This must stay paired
            // with the `system` kickoff above: a hidden root plus the default
            // thread placement would bury every sweep under an invisible
            // message and drop it out of the feed entirely.
            replyPlacement: 'channel',
            status: 'pending',
            threadId: input.trigger.targetThreadId,
            triggerDeliveryId: delivery.id,
            triggerId: input.trigger.id,
          },
          select: { id: true },
        })

        const task = await tx.task.create({
          data: {
            agentId: input.trigger.agentId,
            organizationId: executionOrigin.organizationId,
            purpose: content.slice(0, 200),
            runId: run.id,
            status: 'inbox',
          },
          select: { id: true },
        })

        await enqueueRunExecution(
          tx,
          {
            actorContext: withActionContext(actorContext, {
              taskId: parseTaskId(task.id),
            }),
            agentId: parseAgentId(input.trigger.agentId),
            messageId: message.id,
            runId: parseRunId(run.id),
            taskId: parseTaskId(task.id),
            threadId: parseThreadId(input.trigger.targetThreadId),
          },
          `run:${run.id}`,
        )
      }

      await tx.agentTriggerDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveredAt: new Date(),
          status: 'delivered',
        },
      })

      await tx.agentTrigger.update({
        where: { id: input.trigger.id },
        data: {
          lastFiredAt: new Date(),
        },
      })
    })
  } catch (error) {
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    // sp-webhook: persist a retryable failed delivery (outside the rolled-back
    // tx) so the retry poller can re-attempt with backoff.
    await recordDeliveryFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      existingDeliveryId: input.retry?.reuseDeliveryId,
      payload: normalizedPayload,
      retryCount: input.retry?.retryCount ?? 0,
      source: input.source,
      triggerId: input.trigger.id,
    })
    if (error instanceof TriggerLaunchOriginError) {
      await recordTriggerHealthFailure(prisma, {
        error,
        triggerId: input.trigger.id,
      })
    }
    throw error
  }
}
