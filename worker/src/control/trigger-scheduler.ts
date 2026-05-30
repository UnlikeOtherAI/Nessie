import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { buildNextScheduledRunAt } from '@nessie/runtime'
import type { AgentTriggerType } from '@nessie/schemas'
import { queueTriggerRun, queueWorkflowTriggerRun } from './trigger-run.js'

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

const finalizeScheduledTriggerClaim = async (
  prisma: PrismaClient,
  input: {
    claimId: string
    nextRunAt: Date | null
    status?: 'active' | 'error'
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

  for (const trigger of claimedTriggers) {
    if (trigger.workflowInstallationId) {
      const triggerWithInstallation = await prisma.agentTrigger.findUnique({
        where: { id: trigger.id },
        select: {
          id: true,
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

      if (!triggerWithInstallation?.workflowInstallation) {
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
            id: triggerWithInstallation.id,
            type: triggerWithInstallation.type,
            workflowInstallation: triggerWithInstallation.workflowInstallation,
          },
        })

        await finalizeScheduledTriggerClaim(prisma, {
          claimId: trigger.schedulerClaimId,
          nextRunAt: buildNextScheduledRunAt({
            config: trigger.config,
            from: trigger.nextRunAt,
            now,
            type: trigger.type,
          }),
          status: 'active',
          triggerId: trigger.id,
        })
      } catch {
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

    const triggerWithAgent = await prisma.agentTrigger.findUnique({
      where: { id: trigger.id },
      select: {
        agent: {
          select: {
            organizationId: true,
            projectId: true,
            teamId: true,
          },
        },
        agentId: true,
        config: true,
        id: true,
        targetChannelId: true,
        targetThreadId: true,
        type: true,
      },
    })

    if (
      !triggerWithAgent?.targetChannelId ||
      !triggerWithAgent.targetThreadId ||
      !triggerWithAgent.agentId ||
      !triggerWithAgent.agent
    ) {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: trigger.nextRunAt,
        status: 'error',
        triggerId: trigger.id,
      })
      continue
    }

    try {
      const targetChannelId = triggerWithAgent.targetChannelId
      const targetThreadId = triggerWithAgent.targetThreadId
      const agentId = triggerWithAgent.agentId
      const agent = triggerWithAgent.agent

      await queueTriggerRun(prisma, {
        dedupeKey: `scheduled:${trigger.id}:${trigger.nextRunAt.toISOString()}`,
        payload: {
          scheduledFor: trigger.nextRunAt.toISOString(),
          triggerId: trigger.id,
        },
        source: 'scheduler',
        trigger: {
          agent,
          agentId,
          config: triggerWithAgent.config,
          id: triggerWithAgent.id,
          targetChannelId,
          targetThreadId,
          type: triggerWithAgent.type,
        },
      })

      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: buildNextScheduledRunAt({
          config: trigger.config,
          from: trigger.nextRunAt,
          now,
          type: trigger.type,
        }),
        status: 'active',
        triggerId: trigger.id,
      })
    } catch {
      await finalizeScheduledTriggerClaim(prisma, {
        claimId: trigger.schedulerClaimId,
        nextRunAt: new Date(now.getTime() + DEFAULT_SCHEDULER_RETRY_DELAY_MS),
        triggerId: trigger.id,
      })
    }
  }
}
