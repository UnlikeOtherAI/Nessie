import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { buildNextScheduledRunAt, isOneOffConfig } from '@nessie/runtime'
import type { AgentTriggerType } from '@nessie/schemas'
import {
  emptySkipReferenceTime,
  hasPendingThreadWork,
  recordEmptyFireSkip,
  triggerOptsIntoEmptySkip,
} from './trigger-empty-skip.js'
import { queueTriggerRun } from './trigger-run.js'
import { queueWorkflowTriggerRun } from './workflow-trigger-run.js'

const DEFAULT_SCHEDULER_LEASE_MS = 60_000
const DEFAULT_SCHEDULER_RETRY_DELAY_MS = 60_000

type ClaimedScheduledTrigger = {
  agentId: string | null
  config: unknown
  id: string
  nextRunAt: Date
  schedulerClaimId: string
  targetChannelId: string | null
  targetThreadId: string | null
  type: AgentTriggerType
  workflowInstallationId: string | null
}

const claimDueScheduledTriggers = async (
  prisma: PrismaClient,
  input: {
    leaseMs?: number
    limit: number
    now?: Date
  },
): Promise<ClaimedScheduledTrigger[]> => {
  const now = input.now ?? new Date()
  const claimId = randomUUID()
  const leaseExpiry = new Date(now.getTime() - (input.leaseMs ?? DEFAULT_SCHEDULER_LEASE_MS))

  return prisma.$queryRaw<ClaimedScheduledTrigger[]>(
    Prisma.sql`
      WITH due AS (
        SELECT at.id
        FROM "agent_triggers" AS at
        WHERE at."enabled" = true
          AND at."status" = 'active'::"AgentTriggerStatus"
          AND at."type" IN ('scheduled'::"AgentTriggerType", 'interval'::"AgentTriggerType")
          AND at."next_run_at" IS NOT NULL
          AND at."next_run_at" <= ${now}
          AND (
            at."scheduler_claimed_at" IS NULL
            OR at."scheduler_claimed_at" < ${leaseExpiry}
          )
        ORDER BY at."next_run_at" ASC, at."created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      UPDATE "agent_triggers" AS at
      SET
        "scheduler_claim_id" = ${claimId}::uuid,
        "scheduler_claimed_at" = ${now}
      FROM due
      WHERE at."id" = due."id"
      RETURNING
        at."agent_id" AS "agentId",
        at."config",
        at."id",
        at."next_run_at" AS "nextRunAt",
        at."scheduler_claim_id" AS "schedulerClaimId",
        at."target_channel_id" AS "targetChannelId",
        at."target_thread_id" AS "targetThreadId",
        at."type",
        at."workflow_installation_id" AS "workflowInstallationId"
    `,
  )
}

/**
 * Next fire time plus the status the row should carry afterwards.
 *
 * `buildNextScheduledRunAt` returns null for two different reasons, and they
 * must not look the same on the row: a one-off has simply done its job, while
 * a recurring schedule that returned null has reached its `until` and lapsed.
 * Leaving the latter `active` with no next run would be a silent zombie —
 * indistinguishable from a broken config. Pausing it is reversible: extend the
 * end date and resume.
 */
const settleRecurringClaim = (input: {
  config: unknown
  from: Date
  now: Date
  type: Parameters<typeof buildNextScheduledRunAt>[0]['type']
}): { nextRunAt: Date | null; status: 'active' | 'paused' } => {
  const nextRunAt = buildNextScheduledRunAt(input)
  return {
    nextRunAt,
    status:
      nextRunAt === null && !isOneOffConfig(input.config) ? 'paused' : 'active',
  }
}

const finalizeScheduledTriggerClaim = async (
  prisma: PrismaClient,
  input: {
    claimId: string
    nextRunAt: Date | null
    status?: 'active' | 'error' | 'paused'
    triggerId: string
  },
): Promise<void> => {
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "agent_triggers"
      SET
        "next_run_at" = ${input.nextRunAt},
        "scheduler_claim_id" = NULL,
        "scheduler_claimed_at" = NULL,
        "status" = COALESCE(${input.status}::"AgentTriggerStatus", "status")
      WHERE "id" = ${input.triggerId}::uuid
        AND "scheduler_claim_id" = ${input.claimId}::uuid
    `,
  )
}

export const sweepDueScheduledTriggers = async (
  prisma: PrismaClient,
  input: {
    limit: number
    now?: Date
  },
): Promise<void> => {
  const now = input.now ?? new Date()
  const claimedTriggers = await claimDueScheduledTriggers(prisma, input)

  if (claimedTriggers.length === 0) {
    return
  }

  // Batch-load the related agent/workflowInstallation rows for every claimed
  // trigger in one query instead of re-fetching per trigger inside the loop.
  const relations = await prisma.agentTrigger.findMany({
    where: { id: { in: claimedTriggers.map((trigger) => trigger.id) } },
    select: {
      agent: {
        select: {
          agentKind: true,
          organizationId: true,
          projectId: true,
          teamId: true,
        },
      },
      createdAt: true,
      id: true,
      lastFiredAt: true,
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
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]))

  for (const trigger of claimedTriggers) {
    const relation = relationsById.get(trigger.id)

    if (trigger.workflowInstallationId) {
      const workflowInstallation = relation?.workflowInstallation

      if (!workflowInstallation) {
        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          nextRunAt: trigger.nextRunAt,
          status: 'error',
          triggerId: trigger.id,
        })
        continue
      }

      try {
        await queueWorkflowTriggerRun(prisma, {
          dedupeKey: `scheduled:${trigger.id}:${trigger.nextRunAt.toISOString()}`,
          payload: {
            scheduledFor: trigger.nextRunAt.toISOString(),
            triggerId: trigger.id,
          },
          source: 'scheduler',
          trigger: {
            id: trigger.id,
            type: trigger.type,
            workflowInstallation,
          },
        })

        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          ...settleRecurringClaim({
            config: trigger.config,
            from: trigger.nextRunAt,
            now,
            type: trigger.type,
          }),
          triggerId: trigger.id,
        })
      } catch (error) {
        console.error(
          '[worker.trigger-sweep] workflow dispatch failed',
          JSON.stringify({
            nextRunAt: trigger.nextRunAt.toISOString(),
            triggerId: trigger.id,
          }),
          error,
        )
        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          nextRunAt: new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
          triggerId: trigger.id,
        })
      }
      continue
    }

    if (!trigger.targetChannelId || !trigger.targetThreadId || !trigger.agentId) {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: trigger.nextRunAt,
        status: 'error',
        triggerId: trigger.id,
      })
      continue
    }

    if (!relation?.agent) {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: trigger.nextRunAt,
        status: 'error',
        triggerId: trigger.id,
      })
      continue
    }

    const targetChannelId = trigger.targetChannelId
    const targetThreadId = trigger.targetThreadId
    const agentId = trigger.agentId
    const agent = relation.agent
    const dedupeKey = `scheduled:${trigger.id}:${trigger.nextRunAt.toISOString()}`

    try {
      // Empty-fire skip: an opted-in schedule whose target thread has seen no
      // new work since the last run records a `skipped` delivery and advances
      // the schedule without enqueueing a run, so it never burns tokens on a
      // no-op. Triggers that do not opt in, or whose thread has any pending
      // work, always run — emptiness is never assumed.
      //
      // Inside the per-trigger try, because a throw here used to escape the
      // loop entirely: the remaining claimed triggers were never dispatched and
      // their claims were left to expire, so one bad row stalled the whole
      // batch for a lease period.
      if (
        triggerOptsIntoEmptySkip(trigger.config)
        && !(await hasPendingThreadWork(prisma, {
          agentId,
          since: emptySkipReferenceTime({
            createdAt: relation.createdAt,
            lastFiredAt: relation.lastFiredAt,
          }),
          threadId: targetThreadId,
        }))
      ) {
        await recordEmptyFireSkip(prisma, {
          dedupeKey,
          payload: {
            reason: 'empty_work_source',
            scheduledFor: trigger.nextRunAt.toISOString(),
          },
          source: 'scheduler',
          triggerId: trigger.id,
        })
        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          ...settleRecurringClaim({
            config: trigger.config,
            from: trigger.nextRunAt,
            now,
            type: trigger.type,
          }),
          triggerId: trigger.id,
        })
        continue
      }

      await queueTriggerRun(prisma, {
        dedupeKey,
        payload: {
          scheduledFor: trigger.nextRunAt.toISOString(),
          triggerId: trigger.id,
        },
        source: 'scheduler',
        trigger: {
          agent,
          agentId,
          config: trigger.config,
          id: trigger.id,
          targetChannelId,
          targetThreadId,
          type: trigger.type,
        },
      })

      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        ...settleRecurringClaim({
          config: trigger.config,
          from: trigger.nextRunAt,
          now,
          type: trigger.type,
        }),
        triggerId: trigger.id,
      })
    } catch (error) {
      // Never silently. A bare `catch {}` here meant a trigger that threw
      // before its delivery row existed retried every 60s forever with no log,
      // no delivery, and no counter — invisible by construction. A classified
      // failure (identity, target) has already recorded its own health and is
      // no longer claimable; anything else is genuinely transient and retries.
      console.error(
        '[worker.trigger-sweep] dispatch failed',
        JSON.stringify({
          nextRunAt: trigger.nextRunAt.toISOString(),
          triggerId: trigger.id,
          type: trigger.type,
        }),
        error,
      )
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
        triggerId: trigger.id,
      })
    }
  }
}
