import type { Prisma } from '@prisma/client'
import {
  AGENT_TODO_MAX_STEPS,
  AgentTodoRecordSchema,
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateStepInputSchema,
  AgentTodoTemplateStepsSchema,
  assignStepKeys,
  type AgentTodoRecord,
  type AgentTodoTemplateRecord,
  type AgentTodoTemplateStep,
  type AgentTodoTemplateStepInput,
} from '@nessie/schemas'

export const agentTodoWithOrderedSteps = {
  activeRun: { select: { threadId: true } },
  steps: { orderBy: { sequence: 'asc' as const } },
} satisfies Prisma.AgentTodoInclude

export type AgentTodoWithOrderedSteps = Prisma.AgentTodoGetPayload<{
  include: typeof agentTodoWithOrderedSteps
}>

type AgentTodoTemplateRow = Prisma.AgentTodoTemplateGetPayload<Record<string, never>>

export const mapAgentTodoTemplateRecord = (
  row: AgentTodoTemplateRow,
): AgentTodoTemplateRecord =>
  AgentTodoTemplateRecordSchema.parse({
    ...row,
    steps: AgentTodoTemplateStepsSchema.parse(row.steps),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })

export const mapAgentTodoRecord = (
  row: AgentTodoWithOrderedSteps,
  accessibleThreadIds?: ReadonlySet<string>,
): AgentTodoRecord =>
  AgentTodoRecordSchema.parse({
    ...row,
    activeRunId: row.activeRunId && row.activeRun?.threadId
      && accessibleThreadIds?.has(row.activeRun.threadId)
      ? row.activeRunId
      : accessibleThreadIds === undefined
        ? row.activeRunId
        : null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    steps: row.steps.map((step) => ({
      ...step,
      completedAt: step.completedAt?.toISOString() ?? null,
    })),
    threadId: row.threadId && accessibleThreadIds?.has(row.threadId)
      ? row.threadId
      : accessibleThreadIds === undefined
        ? row.threadId
        : null,
    updatedAt: row.updatedAt.toISOString(),
  })

const parseStepInputs = (
  steps: readonly AgentTodoTemplateStepInput[],
): AgentTodoTemplateStepInput[] =>
  AgentTodoTemplateStepInputSchema.array()
    .min(1)
    .max(AGENT_TODO_MAX_STEPS)
    .parse(steps)

export const prepareAgentTodoSteps = (
  steps: readonly AgentTodoTemplateStepInput[],
): AgentTodoTemplateStep[] =>
  AgentTodoTemplateStepsSchema.parse(assignStepKeys(parseStepInputs(steps)))

/**
 * Existing clients normally send durable keys back. Matching unchanged
 * keyless rows here keeps their address stable too, rather than deriving a
 * fresh key from presentation text on every edit.
 */
export const prepareEditedAgentTodoSteps = (
  existing: readonly AgentTodoTemplateStep[],
  requested: readonly AgentTodoTemplateStepInput[],
): AgentTodoTemplateStep[] => {
  const unusedExisting = [...existing]
  const withPreservedKeys = parseStepInputs(requested).map((step) => {
    if (step.key !== undefined) return step

    const matchIndex = unusedExisting.findIndex(
      (candidate) =>
        candidate.title === step.title
        && candidate.instructions === step.instructions,
    )
    if (matchIndex < 0) return step

    const [match] = unusedExisting.splice(matchIndex, 1)
    return { ...step, key: match?.key }
  })

  return AgentTodoTemplateStepsSchema.parse(assignStepKeys(withPreservedKeys))
}
