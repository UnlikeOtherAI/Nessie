import { Prisma, type PrismaClient } from '@prisma/client'
import { finishWorkflowStepRun } from '../run/workflow-step-finish.js'

// W6 reaper: a crash inside executeWorkflowBuiltinTool used to leave a step
// `running` forever with nothing to reclaim it. This sweep — a sibling of the
// trigger scheduler — fails a still-running step through the Section A guarded
// transition (which terminalizes the run and emits its terminal event) on
// EITHER of two conditions:
//
//   1. an EXPIRED LEASE — the step was actively worked by a worker that wrote
//      leaseOwnerId/leaseExpiresAt and heartbeated; a dead worker stops
//      heartbeating and its lease lapses; or
//   2. an EXPIRED DEADLINE — suspended steps (agent_task, environment_launch,
//      and later approval/human-input/wait) hold no lease and run no heartbeat;
//      they wait on an external continuation and are reclaimed by deadline_at
//      (a step-level timeoutMs, else the 24h suspend default).
//
// A lease-only sweep would never reclaim the likeliest hangs, so both
// conditions must stay. Reclaimed rows are selected FOR UPDATE SKIP LOCKED so
// concurrent sweeps (multiple workers, or a re-run while the previous pass is
// mid-failure) never fight over the same step; the guarded finish transition
// makes a double-fail a no-op anyway.

type ReapedStepRow = {
  deadlineAt: Date | null
  installationChannelId: string | null
  installationId: string
  installationProjectId: string | null
  installationTeamId: string | null
  installationTemplateId: string
  leaseExpiresAt: Date | null
  organizationId: string
  reclaimReason: 'deadline' | 'lease'
  runId: string
  startedByActorId: string
  startedByActorType: string
  stepRunId: string
}

const REAPED_STEP_SELECT = Prisma.sql`
  SELECT
    wsr."id" AS "stepRunId",
    wsr."lease_expires_at" AS "leaseExpiresAt",
    wsr."deadline_at" AS "deadlineAt",
    CASE
      WHEN wsr."lease_expires_at" IS NOT NULL AND wsr."lease_expires_at" <= now()
        THEN 'lease'
      ELSE 'deadline'
    END AS "reclaimReason",
    wr."id" AS "runId",
    wr."organization_id" AS "organizationId",
    wr."started_by_actor_id" AS "startedByActorId",
    wr."started_by_actor_type" AS "startedByActorType",
    wi."id" AS "installationId",
    wi."channel_id" AS "installationChannelId",
    wi."project_id" AS "installationProjectId",
    wi."team_id" AS "installationTeamId",
    wi."workflow_template_id" AS "installationTemplateId"
  FROM "workflow_step_runs" AS wsr
  JOIN "workflow_runs" AS wr ON wr."id" = wsr."workflow_run_id"
  JOIN "workflow_installations" AS wi ON wi."id" = wr."installation_id"
  WHERE wsr."status" = 'running'::"WorkflowStepRunStatus"
    AND wr."status" IN ('pending'::"WorkflowRunStatus", 'running'::"WorkflowRunStatus")
    AND (
      (wsr."lease_expires_at" IS NOT NULL AND wsr."lease_expires_at" <= now())
      OR (wsr."deadline_at" IS NOT NULL AND wsr."deadline_at" <= now())
    )
  ORDER BY wsr."updated_at" ASC
  FOR UPDATE OF wsr SKIP LOCKED
`

export const reapStuckWorkflowSteps = async (
  prisma: PrismaClient,
  input: { limit?: number } = {},
): Promise<{ reaped: number }> => {
  const limit = input.limit ?? 20

  // Read (and lock) the expired rows inside a short transaction, then fail
  // them one at a time outside it: the guarded finish transition is its own
  // transaction and emits terminal events, neither of which belongs inside the
  // lock scope.
  const reaped = await prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ReapedStepRow[]>(Prisma.sql`
      ${REAPED_STEP_SELECT}
      LIMIT ${limit}
    `)
  })

  let failed = 0
  for (const row of reaped) {
    const summary =
      row.reclaimReason === 'lease'
        ? 'Workflow step reclaimed: worker lease expired (the worker working this step crashed or stopped heartbeating).'
        : 'Workflow step reclaimed: deadline expired while waiting on an external continuation.'

    const result = await finishWorkflowStepRun(
      prisma,
      {
        installation: {
          channelId: row.installationChannelId,
          id: row.installationId,
          projectId: row.installationProjectId,
          teamId: row.installationTeamId,
          workflowTemplateId: row.installationTemplateId,
        },
        run: {
          id: row.runId,
          organizationId: row.organizationId,
          startedByActorId: row.startedByActorId,
          startedByActorType: row.startedByActorType,
        },
      },
      {
        stepRunId: row.stepRunId,
        success: false,
        summary,
        workflowRunId: row.runId,
      },
    )

    if (result.applied) {
      failed += 1
      console.warn(
        `[worker.workflow-step-reaper] reclaimed step ${row.stepRunId} (run ${row.runId}) by ${row.reclaimReason}`,
      )
    }
  }

  return { reaped: failed }
}
