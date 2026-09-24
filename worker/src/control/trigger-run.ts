import { Prisma, type PrismaClient } from '@prisma/client'
import {
  prepareScheduledAgentTodoTrigger,
} from '@nessie/team-admin'
import {
  buildTriggerPrompt,
} from '@nessie/runtime'
import {
  type AgentTriggerType,
  type TriggerFireSkipReason,
} from '@nessie/schemas'
import { buildAgentActorContext as buildActorContext, startAgentRun } from './agent-run-start.js'
import { claimThreadRunOrPend } from '../run/thread-serialization.js'
import { recordDeliveryFailure } from './trigger-delivery-retry.js'
import { recordTriggerHealthFailure } from './trigger-health.js'
import {
  TriggerLaunchOriginError,
} from './trigger-origin.js'
import {
  assertTriggerRunAdmission,
  isAgentChannelAdmissionError,
  type TriggerRunAdmissionInput,
} from './trigger-run-admission.js'

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
 * So the webhook dispatcher passes a recorder and event dispatch passes
 * nothing. Scheduled triggers use the separate fail-closed policy: authority
 * loss is an actionable stop, so it writes trigger health and one terminal
 * delivery for the claimed occurrence even when an empty-work check would have
 * skipped it.
 *
 * It is deliberately a hook rather than a second copy of the gate in the
 * webhook handler — the decision has exactly one implementation, and a
 * diagnosis derived from a re-read would drift from it.
 */
export type TriggerFireSkipRecorder = (reason: TriggerFireSkipReason) => Promise<void>

type TriggerRunAdmissionPolicy = 'recheck_then_skip' | 'scheduled_fail_closed'

export type TriggerRunTarget = Omit<TriggerRunAdmissionInput, 'triggerType'> & {
  id: string
  type: AgentTriggerType
}

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

const findExistingDelivery = async (
  prisma: PrismaClient,
  input: { dedupeKey?: string; triggerId: string },
): Promise<{ id: string; status: string } | null> =>
  input.dedupeKey
    ? prisma.agentTriggerDelivery.findFirst({
        where: {
          dedupeKey: input.dedupeKey,
          triggerId: input.triggerId,
        },
        select: { id: true, status: true },
      })
    : null

const occurrenceAlreadyHandled = (
  delivery: { id: string; status: string } | null,
  retry: RetryContext | undefined,
): boolean => {
  if (!delivery) return false
  return !(
    retry?.reuseDeliveryId === delivery.id
    && delivery.status === 'failed'
  )
}

/**
 * A dispatch that threw: a retryable failed delivery (outside the rolled-back
 * transaction), plus the trigger's health when the failure is a classified
 * authority loss. Shared with the ticket dispatcher.
 */
export const recordTriggerRunFailure = async (
  prisma: PrismaClient,
  input: {
    dedupeKey?: string
    error: unknown
    payload: Prisma.InputJsonValue
    retry?: RetryContext
    source: string
    triggerId: string
  },
): Promise<void> => {
  const classified = input.error instanceof TriggerLaunchOriginError
  await recordDeliveryFailure(prisma, {
    dedupeKey: input.dedupeKey,
    error: input.error,
    existingDeliveryId: input.retry?.reuseDeliveryId,
    payload: input.payload,
    retryCount: input.retry?.retryCount ?? 0,
    retryable: !classified,
    source: input.source,
    triggerId: input.triggerId,
  })
  if (input.error instanceof TriggerLaunchOriginError) {
    await recordTriggerHealthFailure(prisma, {
      error: input.error,
      triggerId: input.triggerId,
    })
  }
}

/**
 * Scheduler admission before `skipWhenEmpty` is evaluated.
 *
 * A quiet channel cannot hide revoked authority forever. The same admission is
 * repeated by `queueTriggerRun` after the empty check to close the race. An
 * existing delivery wins first: a replay must never rewrite a delivered,
 * skipped or already-failed occurrence after membership changes.
 */
export const preflightScheduledTriggerRun = async (
  prisma: PrismaClient,
  input: {
    dedupeKey: string
    payload: unknown
    source: string
    trigger: TriggerRunTarget
  },
): Promise<'handled' | 'ready'> => {
  const existing = await findExistingDelivery(prisma, {
    dedupeKey: input.dedupeKey,
    triggerId: input.trigger.id,
  })
  if (existing) return 'handled'

  const payload = normalizePayload(input.payload)
  try {
    await assertTriggerRunAdmission(prisma, {
      ...input.trigger,
      triggerType: input.trigger.type,
    })
    return 'ready'
  } catch (error) {
    await recordTriggerRunFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      payload,
      source: input.source,
      triggerId: input.trigger.id,
    })
    throw error
  }
}

/** Record a structurally broken scheduled target before a full admission input exists. */
export const recordScheduledTriggerAdmissionFailure = async (
  prisma: PrismaClient,
  input: {
    dedupeKey: string
    detail: string
    payload: unknown
    source: string
    triggerId: string
  },
): Promise<void> => {
  const existing = await findExistingDelivery(prisma, {
    dedupeKey: input.dedupeKey,
    triggerId: input.triggerId,
  })
  if (existing) return
  await recordTriggerRunFailure(prisma, {
    dedupeKey: input.dedupeKey,
    error: new TriggerLaunchOriginError('agent_channel_access_lost', input.detail),
    payload: normalizePayload(input.payload),
    source: input.source,
    triggerId: input.triggerId,
  })
}

export const queueTriggerRun = async (
  prisma: PrismaClient,
  input: {
    admissionPolicy?: TriggerRunAdmissionPolicy
    dedupeKey?: string
    /** See `TriggerFireSkipRecorder`: only the webhook dispatcher passes one. */
    onSkipped?: TriggerFireSkipRecorder
    payload: unknown
    retry?: RetryContext
    source: string
    trigger: TriggerRunTarget
  },
): Promise<void> => {
  // The personal assistant is its owner's delegate, so it is exempt from the
  // *binding* gate — it is not bound to channels the way a shared agent is. It
  // is NOT exempt from the membership re-check: a PA's reach is its owner's
  // reach, so if the owner has since left any target channel the unattended
  // trigger must not fire, even where ordinary public browsing remains open.
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
  const existingDelivery = await findExistingDelivery(prisma, {
    dedupeKey: input.dedupeKey,
    triggerId: input.trigger.id,
  })
  if (occurrenceAlreadyHandled(existingDelivery, input.retry)) {
    return
  }
  const normalizedPayload = normalizePayload(input.payload)
  try {
    let admission
    try {
      admission = await assertTriggerRunAdmission(prisma, {
        ...input.trigger,
        triggerType: input.trigger.type,
      })
    } catch (error) {
      if (
        input.admissionPolicy !== 'scheduled_fail_closed'
        && isAgentChannelAdmissionError(error)
      ) {
        await input.onSkipped?.('agent_not_bound')
        return
      }
      throw error
    }
    const { executionOrigin, isPersonalAssistantTrigger } = admission
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
    await recordTriggerRunFailure(prisma, {
      dedupeKey: input.dedupeKey,
      error,
      payload: normalizedPayload,
      retry: input.retry,
      source: input.source,
      triggerId: input.trigger.id,
    })
    throw error
  }
}
