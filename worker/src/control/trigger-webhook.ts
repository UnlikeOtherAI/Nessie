import { Prisma, type PrismaClient } from '@prisma/client'

import type {
  TriggerFireSkipReason,
  TriggerWebhookDispatchJobPayload,
} from '@nessie/schemas'

import {
  normalizePayload,
  queueTriggerRun,
  type TriggerFireSkipRecorder,
} from './trigger-run.js'
import { queueWorkflowTriggerRun } from './workflow-trigger-run.js'

/**
 * `trigger.webhook.dispatch` — one verified inbound delivery, fired.
 *
 * The intake routes authenticate the delivery and answer the sender's
 * "is this trigger usable" questions synchronously; the fire lands here, on the
 * same `queueTriggerRun` / `queueWorkflowTriggerRun` seam the scheduler sweep
 * and event dispatch already use. It used to run inline in the request, so a
 * sender waited out a launch-origin preflight, a UOA identity check and a
 * six-write transaction, and an instance recycled part-way through lost a
 * delivery it had already accepted (docs/standards/horizontal-scaling.md § 3;
 * audit 9.2).
 *
 * **Everything is re-checked here**, not trusted from the ack: the queue is
 * at-least-once, and a trigger can be paused, unbound or deleted between the
 * 202 and the claim. A trigger that is no longer fireable is not an error — the
 * job succeeds having done nothing, exactly as event dispatch treats the same
 * case.
 *
 * **A recheck that stops a fire says so on the delivery row.** Rechecking is
 * right; being silent about it is not. This receiver's 202 hands the sender a
 * `dedupeKey` and calls it the key `GET /api/triggers/:id/deliveries` reports
 * for that fire, so a skip that wrote nothing left that handle resolving to
 * nothing, forever, and indistinguishable from a fire still in flight: an
 * operator would find a *succeeded* queue job and no trace of the delivery. So
 * every claim-time refusal writes a terminal `skipped` delivery under that exact
 * key, carrying the readiness reason (`trigger_paused`, `agent_not_bound`,
 * `workflow_installation_not_ready`) the receiver's own 409 would have carried a
 * second earlier — the same treatment `queueWorkflowTriggerRun` already gives an
 * overlap skip, and `recordEmptyFireSkip` an empty fire.
 *
 * The one case that cannot leave a row is a trigger *deleted* between the ack
 * and the claim: `agent_trigger_deliveries.trigger_id` is `ON DELETE CASCADE`,
 * so its deliveries went with it and a new row would fail the foreign key. The
 * handle still resolves — `GET /api/triggers/:id/deliveries` 404s on the trigger
 * itself, which is an answer, not silence.
 *
 * **Replay-safe through the delivery key.** `dedupeKey` is the sender's delivery
 * id, namespaced `webhook:<id>` — the same key the inline path wrote, so rows
 * created before this change still collapse. `queueTriggerRun` short-circuits on
 * a delivery that already has a run, and the `(trigger_id, dedupe_key)` unique
 * index catches the concurrent case, which it answers by returning rather than
 * throwing. A sender that offers no delivery id gets a per-request key, so it
 * fires every time — the honest reading of a delivery with nothing to dedupe on,
 * and what it already did.
 */
const WEBHOOK_SOURCE = 'webhook'

/**
 * The terminal record of a fire the claim-time recheck stopped.
 *
 * `create`, not `upsert`: a row already under this key is the fire itself —
 * `delivered`, or `failed` and awaiting the retry poller — and a replay of this
 * job arriving after the trigger was paused must not overwrite it with a skip.
 * The unique `(trigger_id, dedupe_key)` index makes that safe under concurrency
 * too, and its violation is the answer rather than an error, exactly as
 * `recordEmptyFireSkip` treats it.
 *
 * The row is terminal in the other direction as well: once a delivery is on
 * record as skipped, a re-claim of the same job — a dropped ack, an expired
 * lease — will not fire it even if the trigger has been un-paused in between,
 * because `upsertDelivery` collides on the key and `queueTriggerRun` reads that
 * collision as "already handled". That is the intent. This row IS the delivery
 * ledger for the sender's delivery id, and a later fire under it would leave a
 * `skipped` delivery sitting beside the run it claims never happened. The next
 * delivery from the sender carries the next id and fires normally.
 */
const recordWebhookFireSkip = async (
  prisma: PrismaClient,
  input: { dedupeKey: string; payload: unknown; triggerId: string },
  reason: TriggerFireSkipReason,
): Promise<void> => {
  try {
    await prisma.agentTriggerDelivery.create({
      data: {
        dedupeKey: input.dedupeKey,
        // Named on the row an operator reads, so "nothing ran" is diagnosable
        // without correlating a queue job that succeeded.
        errorMessage: reason,
        payload: normalizePayload(input.payload),
        source: WEBHOOK_SOURCE,
        status: 'skipped',
        triggerId: input.triggerId,
      },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return
    }
    throw error
  }
}

export const dispatchWebhookTrigger = async (
  prisma: PrismaClient,
  input: TriggerWebhookDispatchJobPayload,
): Promise<void> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: input.triggerId },
    select: {
      agent: {
        select: {
          agentKind: true,
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      agentId: true,
      config: true,
      enabled: true,
      status: true,
      targetChannelId: true,
      targetThreadId: true,
      type: true,
      workflowInstallation: {
        select: {
          active: true,
          channelId: true,
          id: true,
          organizationId: true,
          projectId: true,
          status: true,
          teamId: true,
        },
      },
    },
  })

  // The namespace `dispatchAgentTrigger` applied inline, kept verbatim so a
  // delivery row written before this change still dedupes against its retry.
  const dedupeKey = `webhook:${input.dedupeKey}`
  const skipped: TriggerFireSkipRecorder = (reason) =>
    recordWebhookFireSkip(
      prisma,
      { dedupeKey, payload: input.payload, triggerId: input.triggerId },
      reason,
    )

  if (!trigger) {
    // Deleted between the ack and the claim: the cascade took its deliveries, so
    // there is nowhere to write. See the header — the trigger's own 404 is the
    // answer here.
    return
  }

  if (!trigger.enabled || trigger.status !== 'active') {
    await skipped('trigger_paused')
    return
  }

  if (trigger.workflowInstallation) {
    await queueWorkflowTriggerRun(prisma, {
      dedupeKey,
      onSkipped: skipped,
      payload: input.payload,
      source: WEBHOOK_SOURCE,
      trigger: {
        id: input.triggerId,
        type: trigger.type,
        workflowInstallation: trigger.workflowInstallation,
      },
    })
    return
  }

  if (!trigger.agentId || !trigger.agent || !trigger.targetChannelId || !trigger.targetThreadId) {
    await skipped('agent_not_bound')
    return
  }

  await queueTriggerRun(prisma, {
    dedupeKey,
    onSkipped: skipped,
    payload: input.payload,
    source: WEBHOOK_SOURCE,
    trigger: {
      agent: trigger.agent,
      agentId: trigger.agentId,
      // Carried so a webhook trigger's saved prompt and scheduled-to-do marker
      // are read the way every other fire path reads them; the inline dispatcher
      // passed it to the to-do marker but not to the prompt builder, so a
      // webhook trigger's own `config.prompt` was silently ignored.
      config: trigger.config,
      id: input.triggerId,
      targetChannelId: trigger.targetChannelId,
      targetThreadId: trigger.targetThreadId,
      type: trigger.type,
    },
  })
}
