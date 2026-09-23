import { z } from 'zod'
import { enqueueQueueJob } from '@nessie/db'
import {
  DEEP_WATER_RESEARCH_EVENT_TOPIC,
  DeepWaterResearchEventJobPayloadSchema,
  DeepWaterScopeStateSchema,
  deepWaterResearchEventJobKey,
  type DeepWaterResearchEvent,
  type DeepWaterResearchEventJobPayload,
  type DeepWaterResearchProgress,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'

import {
  deepWaterBriefJson,
  lockDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * DeepWater's research events on Nessie's side (Water plan
 * amendments-streaming S2): which run an event is about, the job that carries
 * it to the worker, and the one fact an event sets directly — a running
 * research's progress. Everything else an event reports is re-read through
 * Ledger by the watch's own functions; the event only triggers the read.
 */

const isUuid = (value: string | null): value is string => value !== null && z.string().uuid().safeParse(value).success

/** Why an authentic event matched nothing Nessie can act on; DeepWater completes its delivery. */
export type DeepWaterEventRefusal =
  /** No run of that organisation is bound to the research, and none opened it. */
  | 'run_not_found'
  /**
   * A launcher run from before research briefs: its handoff delivers it and
   * its agent writes its status, so an event has nothing to change there.
   */
  | 'legacy_run'

export type DeepWaterEventResolution =
  | { kind: 'run'; organizationId: string; runId: string }
  | { kind: 'refused'; reason: DeepWaterEventRefusal }

/**
 * The run an event is about, always inside the organisation the event names:
 * the run bound to its research (`external_run_id`), or else an agent's brief
 * whose research id never came back — found by the call that opened it, the
 * agent's Run, its provider tool-call id and the agent (N1). A person's brief
 * is attached by the opening job that is still retrying it, so an event for
 * one not yet attached is not accepted; the watch sees it once it is.
 */
export const resolveDeepWaterEventRun = async (
  db: DeepWaterBriefDb,
  event: Pick<DeepWaterResearchEvent, 'research' | 'nessie'>,
): Promise<DeepWaterEventResolution> => {
  const organizationId = event.nessie.organization_id
  if (!isUuid(organizationId)) return { kind: 'refused', reason: 'run_not_found' }
  const bound = await db.productIntegrationRun.findFirst({
    where: {
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      organizationId,
      externalRunId: event.research.ledger_research_id,
    },
    select: { id: true, uoaIdentity: true },
  })
  if (bound) {
    return bound.uoaIdentity === null
      ? { kind: 'refused', reason: 'legacy_run' }
      : { kind: 'run', organizationId, runId: bound.id }
  }
  const { agent_id: agentId, run_id: runId, tool_call_id: toolCallId } = event.nessie
  if (!isUuid(runId) || !isUuid(agentId) || toolCallId === null) return { kind: 'refused', reason: 'run_not_found' }
  const opened = await db.productIntegrationRun.findFirst({
    where: {
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      organizationId,
      externalRunId: null,
      originKind: 'agent',
      originRunId: runId,
      originToolCallId: toolCallId,
      originAgentId: agentId,
    },
    select: { id: true, uoaIdentity: true },
  })
  return opened && opened.uoaIdentity !== null
    ? { kind: 'run', organizationId, runId: opened.id }
    : { kind: 'refused', reason: 'run_not_found' }
}

/**
 * Queue a verified event for the worker, keyed by DeepWater's event id: an
 * event DeepWater sends again (a retried delivery, its start-up sweep) is
 * queued once. False when it was queued before.
 */
export const enqueueDeepWaterResearchEvent = async (
  db: DeepWaterBriefDb,
  payload: DeepWaterResearchEventJobPayload,
): Promise<boolean> => {
  const parsed = DeepWaterResearchEventJobPayloadSchema.parse(payload)
  return enqueueQueueJob(db, {
    idempotencyKey: deepWaterResearchEventJobKey(parsed.event.event_id),
    // One try: the watch reads the run again anyway, so a failed handling is
    // caught by the backstop rather than repeated.
    maxAttempts: 1,
    payload: parsed,
    topic: DEEP_WATER_RESEARCH_EVENT_TOPIC,
  })
}

/** A run whose progress still means something: agreed and launching, running, or waiting on an operator. */
const PROGRESS_STATUSES: ReadonlySet<ProductIntegrationRunStatus> = new Set(['drafting', 'running', 'needs_setup'])

export type DeepWaterProgressOutcome =
  | { applied: true; run: DeepWaterBriefRun }
  | {
      applied: false
      /**
       * `not_found`: no brief run of that organisation. `not_bound`: the run is
       * not (yet) bound to that research. `closed`: the run has ended.
       * `stale`: DeepWater observed the stored snapshot no earlier.
       */
      reason: 'not_found' | 'not_bound' | 'closed' | 'stale'
    }

/**
 * Store a running research's progress (`scope_json.progress`) when DeepWater
 * observed it later than the snapshot already stored, under the row lock, so
 * snapshots arriving out of order never move the card backwards. It marks the
 * run changed (`ledger_observed_at`) and records that an event arrived. It
 * never touches the brief registers, the status or the delivery: progress
 * reports where a research is, and nothing is decided on it.
 */
export const applyDeepWaterProgress = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; researchId: string; progress: DeepWaterResearchProgress },
): Promise<DeepWaterProgressOutcome> => {
  const locked = await lockDeepWaterBriefRun(tx, input)
  const state = locked?.run.scopeState
  if (!locked || !state) return { applied: false, reason: 'not_found' }
  const { run, now } = locked
  if (run.externalRunId !== input.researchId) return { applied: false, reason: 'not_bound' }
  if (!PROGRESS_STATUSES.has(run.status)) return { applied: false, reason: 'closed' }
  if (state.progress !== null && Date.parse(state.progress.at) >= Date.parse(input.progress.at)) {
    await tx.productIntegrationRun.update({ where: { id: run.id }, data: { lastEventAt: now } })
    return { applied: false, reason: 'stale' }
  }
  const scopeState = DeepWaterScopeStateSchema.parse({ ...state, progress: input.progress })
  await tx.productIntegrationRun.update({
    where: { id: run.id },
    data: { scopeJson: deepWaterBriefJson(scopeState), ledgerObservedAt: now, lastEventAt: now },
  })
  return { applied: true, run: { ...run, scopeState, ledgerObservedAt: now, lastEventAt: now } }
}
