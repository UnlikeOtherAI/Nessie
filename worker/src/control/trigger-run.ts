import { Prisma, type PrismaClient } from '@prisma/client'
import {
  prepareScheduledAgentTodoTrigger,
} from '@nessie/team-admin'
import {
  activeTeamMatchesAttribution,
  buildTriggerPrompt,
  loadLedgerIdentitySettings,
  loadLedgerUoaIdentity,
} from '@nessie/runtime'

// Read once at startup: whether this deployment signs Ledger calls is never a
// per-request, per-organization or per-user decision.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null
import {
  type AgentTriggerType,
  type TriggerFireSkipReason,
} from '@nessie/schemas'
import { buildAgentActorContext as buildActorContext, startAgentRun } from './agent-run-start.js'
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

/**
 * Told when this fire is refused by the gate below rather than executed.
 *
 * Recheck-then-skip is the correct behaviour and stays: the queue is
 * at-least-once, and a trigger can be paused, unbound or deleted between a
 * caller's acknowledgement and the claim. What is not correct is being *silent*
 * about it, for the one caller that was handed a handle on this fire — the
 * webhook receiver's 202 promises its `dedupeKey` is the key
 * `GET /api/triggers/:id/deliveries` reports, and a skip that writes no row
 * leaves that promise unresolvable and indistinguishable from still-in-flight.
 * So the webhook dispatcher passes a recorder and every other caller passes
 * nothing: the scheduler sweep and event dispatch answer nobody, and a delivery
 * row per quiet sweep tick would be noise, not diagnosis.
 *
 * It is deliberately a hook rather than a second copy of the gate in the
 * webhook handler — the decision has exactly one implementation, and a
 * diagnosis derived from a re-read would drift from it.
 */
export type TriggerFireSkipRecorder = (reason: TriggerFireSkipReason) => Promise<void>

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

export const queueTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    /** See `TriggerFireSkipRecorder`: only the webhook dispatcher passes one. */
    onSkipped?: TriggerFireSkipRecorder
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
  //
  // DELIBERATELY STILL PA-KEYED, not moved onto the shared delegation
  // predicate. What is exempted here is the binding lookup, and a DM-homed
  // global agent is genuinely bound: bootstrap writes exactly one
  // `AgentBinding` into its home DM. So it needs no exemption, and granting it
  // one would let a leftover trigger row fire into a channel the agent is not
  // bound to. v1 global agents own no automation at all — `createAgentTrigger`
  // refuses a `systemSlug` target — and a row that predates that refusal is
  // stopped twice more downstream: `assertGlobalAgentRunPlacement` refuses any
  // destination but the home DM, and the identity-tool gate admits nothing on a
  // run that is not an interactive human turn.
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
    // The same word the receiver's readiness predicate uses for a target that
    // no longer hangs together — its 409 is `AGENT_NOT_BOUND` for this too.
    await input.onSkipped?.('agent_not_bound')
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
      await input.onSkipped?.('agent_not_bound')
      return
    }
  }

  const content = buildTriggerPrompt({
    config: input.trigger.config,
    payload: input.payload,
    source: input.source,
    triggerType: input.trigger.type,
  })
  const scheduledTodo = prepareScheduledAgentTodoTrigger({
    config: input.trigger.config,
    triggerId: input.trigger.id,
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
    // external UOA mapping to match the captured team. Checking the
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
      const teamMatches = await activeTeamMatchesAttribution(
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
      if (!teamMatches) {
        throw new TriggerLaunchOriginError(
          'uoa_identity_unverifiable',
          'its saved UnlikeOtherAI team no longer maps to its team',
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
          ...((isPersonalAssistantTrigger || scheduledTodo)
            ? {
                metadata: {
                  ...(isPersonalAssistantTrigger
                    ? { delegatedByAgentId: input.trigger.agentId }
                    : {}),
                  ...(scheduledTodo
                    ? scheduledTodo.metadata
                    : {}),
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
          ...(scheduledTodo ? { todoTemplateId: scheduledTodo.todoTemplateId } : {}),
        },
      })

      if (claim === 'claimed') {
        await startAgentRun(tx, {
          actorContext,
          agentId: input.trigger.agentId,
          channelId: input.trigger.targetChannelId,
          messageId: message.id,
          organizationId: executionOrigin.organizationId,
          purpose: content,
          threadId: input.trigger.targetThreadId,
          triggerDeliveryId: delivery.id,
          triggerId: input.trigger.id,
        })
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
