import type { PrismaClient } from '@prisma/client'

import {
  publishMessageEnvelope,
  type MessageEnvelopePublisher,
} from '@nessie/runtime'
import type { DeepSignalInsightFanoutJobPayload } from '@nessie/schemas'
import {
  handleDeepSignalInsightSurfaced,
  type InsightFanoutResult,
  type SignalDigestOptions,
} from '@nessie/team-admin'

import { buildRealtimeScopesForChannel } from '../run/pa-tools/message-destination.js'

/**
 * `deepsignal.insight.fanout` — one verified `insight.surfaced` event, fanned
 * out to the linked members of the team it named.
 *
 * The receiver (`POST /api/integrations/deepsignal/events`) verifies the HMAC,
 * resolves the signing organisation and the payload's enabled team, and acks.
 * Everything per-recipient runs here: a channel lookup, a thread, a binding and
 * a digest transaction each. It used to run inline, so one insight for a
 * fifty-person team held the request open across fifty digest transactions, and
 * an instance recycled part-way through lost the remainder after DeepSignal had
 * already been told 2xx and would never send it again
 * (docs/standards/horizontal-scaling.md § 3; audit 9.2).
 *
 * **Replay-safe without leaning on the enqueue key.** The queue is at-least-once
 * and a re-claimed job re-runs, so the guarantee has to be in the write:
 * `deliverInsightToDigest` takes a per-thread advisory lock and answers an
 * insight already recorded on a live digest with `duplicate`, writing nothing
 * and returning the message it found. This handler announces only a `posted`
 * delivery, so a replay publishes nothing either — which is also why the
 * announcement is a `message.new` for a *fresh* digest and silence for a fold,
 * exactly as it was on the request path.
 *
 * A throw fails the job, which records the reason on `queue_jobs.error_message`
 * and retries under the topic's `max_attempts`; nothing here is a silent drop.
 */

export type DeepSignalInsightFanoutDeps = {
  prisma: PrismaClient
  /** Absent on a deployment with no realtime transport; the rows still land. */
  realtimeTransport: MessageEnvelopePublisher | null
}

/**
 * Non-negative-integer env override, else undefined (service default applies).
 * `0` is a valid, distinct value — notably `NESSIE_SIGNAL_BUDGET_MAX=0` suppresses
 * every fresh proactive digest. Negatives and fractions are rejected (fall back
 * to the default) rather than silently coerced.
 */
const envNonNegativeInt = (name: string): number | undefined => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Delivery-shaping options for the proactive digest, from env. Absent vars leave
 * the service's heuristic defaults (coalesce ~1h, budget ~6 fresh digests / 24h)
 * in force — deliberate, overridable defaults, not hard rules.
 *
 * Read in the worker now that the fan-out is a job. The three `NESSIE_SIGNAL_*`
 * vars therefore have to reach the worker's environment, which they do: one
 * image, one env file (docs/deployment/configuration.md).
 */
export const digestOptionsFromEnv = (): SignalDigestOptions => ({
  coalesceWindowMs: envNonNegativeInt('NESSIE_SIGNAL_DIGEST_WINDOW_MS'),
  budgetWindowMs: envNonNegativeInt('NESSIE_SIGNAL_BUDGET_WINDOW_MS'),
  budgetMax: envNonNegativeInt('NESSIE_SIGNAL_BUDGET_MAX'),
})

/**
 * Best-effort live notification, only for a *freshly posted* digest message.
 * Coalesced/suppressed insights update an existing message in place, so they must
 * not re-emit `message.new` — that is the whole point of batching over interrupts.
 */
const publishInsightDeliveries = async (
  transport: MessageEnvelopePublisher | null,
  organizationId: string,
  result: InsightFanoutResult,
): Promise<void> => {
  if (!transport) return
  for (const delivery of result.deliveries) {
    if (delivery.mode !== 'posted') continue
    try {
      await publishMessageEnvelope(
        transport,
        buildRealtimeScopesForChannel({
          channelId: delivery.channelId,
          organizationId,
          systemChannelType: 'external_agent',
        }),
        {
          channelId: delivery.channelId,
          message: {
            agentId: delivery.agentId,
            // The digest body is fetched by the feed; the announcement only says
            // a fresh digest landed.
            content: 'New signals from DeepSignal',
            id: delivery.messageId,
            // The one role `postDigestMessage` writes
            // (packages/team-admin/src/deepsignal-digest.ts).
            role: 'assistant',
          },
          threadId: delivery.threadId,
        },
      )
    } catch {
      // A realtime publish failure must never fail the job — the message row is
      // already persisted and will load on the next fetch/hydration. Failing
      // here would replay the whole fan-out for a dropped notification.
    }
  }
}

export const runDeepSignalInsightFanout = async (
  deps: DeepSignalInsightFanoutDeps,
  job: DeepSignalInsightFanoutJobPayload,
): Promise<InsightFanoutResult> => {
  const result = await handleDeepSignalInsightSurfaced(
    deps.prisma,
    job.organizationId,
    job.payload,
    digestOptionsFromEnv(),
  )
  await publishInsightDeliveries(deps.realtimeTransport, job.organizationId, result)
  return result
}
