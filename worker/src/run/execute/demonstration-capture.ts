import { Prisma, type PrismaClient } from '@prisma/client'

import { redactDetectedSecrets } from '@nessie/schemas'
import { redactToolInputValue } from '../tool-util.js'

const DEMONSTRATION_CONTROL_TOOLS = new Set([
  'demonstration_start',
  'demonstration_stop',
])
const DEFAULT_DEMONSTRATION_MAX_STEPS = 200

const demonstrationMaxSteps = (): number => {
  const configured = Number(process.env['NESSIE_DEMONSTRATION_MAX_STEPS'])
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DEMONSTRATION_MAX_STEPS
}

/**
 * `redactToolInputValue` only knows key names, so a credential sitting under an
 * ordinary key — `{ body: 'api_key=…' }`, `{ url: '…?token=…' }` — reached
 * `agent_demonstration_steps.arguments_json` verbatim and stayed there.
 * `summarizeToolInput` already runs both passes; this is the durable sink and
 * needs the same pair.
 */
const toRedactedJson = (argumentsValue: Record<string, unknown>): string => {
  const serialized = JSON.stringify(redactToolInputValue(argumentsValue))
  if (serialized === undefined) throw new Error('Tool arguments could not be serialized.')
  return redactDetectedSecrets(serialized)
}

/**
 * Appends one completed structural tool action while the current agent/thread
 * is armed. The CTE allocates the sequence and inserts the row as one database
 * statement, so concurrent tool calls cannot interleave or duplicate a step.
 */
const appendDemonstrationStep = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    argumentsValue: Record<string, unknown>
    demonstrationId: string
    durationMs: number
    endedAt: Date
    organizationId: string
    runId: string
    startedAt: Date
    success: boolean
    threadId: string
    toolName: string
  },
): Promise<void> => {
  const argumentsJson = toRedactedJson(input.argumentsValue)
  const maxSteps = demonstrationMaxSteps()
  await prisma.$executeRaw(Prisma.sql`
    WITH expired AS (
      UPDATE "demonstrations"
      SET "captured_at" = now(), "status" = 'captured'::"DemonstrationStatus"
      WHERE "id" = ${input.demonstrationId}::uuid
        AND "agent_id" = ${input.agentId}::uuid
        AND "organization_id" = ${input.organizationId}::uuid
        AND "thread_id" = ${input.threadId}::uuid
        AND "status" = 'recording'
        AND "expires_at" <= now()
    ), next_step AS (
      UPDATE "demonstrations"
      SET
        "step_count" = "step_count" + 1,
        "captured_at" = CASE WHEN "step_count" + 1 >= ${maxSteps} THEN now() ELSE NULL END,
        "status" = (CASE WHEN "step_count" + 1 >= ${maxSteps} THEN 'captured' ELSE 'recording' END)::"DemonstrationStatus"
      WHERE "id" = ${input.demonstrationId}::uuid
        AND "agent_id" = ${input.agentId}::uuid
        AND "organization_id" = ${input.organizationId}::uuid
        AND "thread_id" = ${input.threadId}::uuid
        AND "status" = 'recording'
        AND "expires_at" > now()
        AND "step_count" < ${maxSteps}
      RETURNING "id", "step_count"
    )
    INSERT INTO "demonstration_steps" (
      "id", "demonstration_id", "run_id", "agent_id", "sequence",
      "tool_name", "arguments_json", "success", "started_at", "ended_at", "duration_ms"
    )
    SELECT
      gen_random_uuid(), next_step."id", ${input.runId}::uuid, ${input.agentId}::uuid,
      next_step."step_count", ${input.toolName}, ${argumentsJson}::jsonb,
      ${input.success}, ${input.startedAt}, ${input.endedAt}, ${input.durationMs}
    FROM next_step
  `)
}

/** Capture failure is deliberately contained: recording is an opt-in aid, not run correctness. */
export const captureDemonstrationToolEnd = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    argumentsValue: Record<string, unknown>
    demonstrationId?: string | null
    durationMs: number
    endedAt: Date
    organizationId: string
    runId: string
    startedAt: Date
    success: boolean
    threadId: string
    toolName: string
  },
): Promise<void> => {
  if (!input.demonstrationId || DEMONSTRATION_CONTROL_TOOLS.has(input.toolName)) return
  try {
    await appendDemonstrationStep(prisma, {
      ...input,
      demonstrationId: input.demonstrationId,
    })
  } catch (error) {
    console.error('[demonstration] Failed to capture tool step', error)
  }
}
