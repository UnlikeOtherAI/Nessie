import { AgentRunLimitsSchema, type AgentRunLimits } from '@nessie/schemas'

/**
 * Agent Designer's "Run limits" fieldset state.
 *
 * Every field is a raw input string so a blank field means "no explicit limit"
 * (the key is omitted and the deployment backstop governs that dimension). Only
 * duration is re-expressed for humans: the contract stores `maxWallclockMs`,
 * the form shows minutes.
 */
export type RunLimitsFormState = {
  maxCostCents: string
  maxDurationMinutes: string
  maxIterations: string
  maxTokens: string
  maxToolCalls: string
}

export const emptyRunLimitsForm: RunLimitsFormState = {
  maxCostCents: '',
  maxDurationMinutes: '',
  maxIterations: '',
  maxTokens: '',
  maxToolCalls: '',
}

export type RunLimitsField = keyof RunLimitsFormState

const MS_PER_MINUTE = 60_000

const positiveInteger = (raw: string): number | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

const millisecondsFromMinutes = (raw: string): number | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const minutes = Number(trimmed)
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  const milliseconds = Math.round(minutes * MS_PER_MINUTE)
  return milliseconds > 0 ? milliseconds : undefined
}

/**
 * The value to send with an agent create/update: an object with only the
 * dimensions the operator filled in, or `null` when every field is blank (which
 * clears any previously stored limits).
 */
export const buildRunLimits = (form: RunLimitsFormState): AgentRunLimits | null => {
  const limits: AgentRunLimits = {}
  const maxTokens = positiveInteger(form.maxTokens)
  if (maxTokens !== undefined) limits.maxTokens = maxTokens
  const maxToolCalls = positiveInteger(form.maxToolCalls)
  if (maxToolCalls !== undefined) limits.maxToolCalls = maxToolCalls
  const maxIterations = positiveInteger(form.maxIterations)
  if (maxIterations !== undefined) limits.maxIterations = maxIterations
  const maxWallclockMs = millisecondsFromMinutes(form.maxDurationMinutes)
  if (maxWallclockMs !== undefined) limits.maxWallclockMs = maxWallclockMs
  const maxCostCents = positiveInteger(form.maxCostCents)
  if (maxCostCents !== undefined) limits.maxCostCents = maxCostCents
  return Object.keys(limits).length > 0 ? limits : null
}

const toInput = (value: number | undefined): string =>
  value === undefined ? '' : String(value)

export const runLimitsToForm = (limits: AgentRunLimits | null): RunLimitsFormState => {
  if (!limits) return emptyRunLimitsForm
  return {
    maxCostCents: toInput(limits.maxCostCents),
    // Exact for any whole number of minutes; a sub-minute limit set through the
    // API renders as its fractional minute rather than being rounded away.
    maxDurationMinutes: toInput(
      limits.maxWallclockMs === undefined
        ? undefined
        : limits.maxWallclockMs / MS_PER_MINUTE,
    ),
    maxIterations: toInput(limits.maxIterations),
    maxTokens: toInput(limits.maxTokens),
    maxToolCalls: toInput(limits.maxToolCalls),
  }
}

/**
 * Read `runLimits` off an agent record. The shared `AgentRecord` client type
 * does not carry the field yet, so the value is validated through the same
 * contract schema the API writes with.
 */
export const readAgentRunLimits = (agent: unknown): AgentRunLimits | null => {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null
  const raw = (agent as Record<string, unknown>).runLimits
  if (raw === null || raw === undefined) return null
  const parsed = AgentRunLimitsSchema.safeParse(raw)
  if (!parsed.success || Object.keys(parsed.data).length === 0) return null
  return parsed.data
}
