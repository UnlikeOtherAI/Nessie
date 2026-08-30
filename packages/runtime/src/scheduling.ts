import { CronExpressionParser } from 'cron-parser'
import {
  ScheduledTriggerLaunchOriginSchema,
  type AgentTriggerType,
  type ScheduledTriggerLaunchOrigin,
} from '@nessie/schemas'

// Single source of truth for schedule config parsing + next-run math, shared by
// the API trigger service and the worker scheduler so the two can never drift.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MEMORY_NUDGE =
  'When you finish, store the key findings in your long-term memory so you can '
  + 'build on them next time.'

export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parsePositiveInteger = (value: unknown): number | null => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || !Number.isInteger(value)
  ) {
    return null
  }
  return value
}

export const parseScheduledCronConfig = (
  config: unknown,
): { cron: string; timezone?: string } | null => {
  if (!isJsonRecord(config)) {
    return null
  }

  const cron = config['cron']
  if (typeof cron !== 'string' || cron.trim().length === 0) {
    return null
  }

  const timezone =
    typeof config['timezone'] === 'string' && config['timezone'].trim().length > 0
      ? config['timezone']
      : undefined

  try {
    CronExpressionParser.parse(cron, {
      currentDate: new Date(),
      ...(timezone ? { tz: timezone } : {}),
    })
  } catch {
    return null
  }

  return { cron, timezone }
}

export const parseIntervalMinutes = (config: unknown): number | null => {
  if (!isJsonRecord(config)) {
    return null
  }
  return parsePositiveInteger(config['interval_minutes'])
}

export const computeNextCronRunAt = (input: {
  config: unknown
  currentDate: Date
}): Date | null => {
  const scheduled = parseScheduledCronConfig(input.config)
  if (!scheduled) {
    return null
  }

  try {
    return CronExpressionParser.parse(scheduled.cron, {
      currentDate: input.currentDate,
      ...(scheduled.timezone ? { tz: scheduled.timezone } : {}),
    })
      .next()
      .toDate()
  } catch {
    return null
  }
}

export const isOneOffConfig = (config: unknown): boolean =>
  isJsonRecord(config) && config['mode'] === 'once'

/**
 * Optional end of a recurring schedule ("watch this until 9am tomorrow").
 *
 * A temporary watch — an incident window, a migration, an overnight soak — is
 * a normal shape, and without this every recurring trigger runs forever and
 * has to be remembered and paused by hand. Invalid or absent reads as "no
 * end", so a malformed value can never silently stop a schedule.
 */
export const parseScheduleUntil = (config: unknown): Date | null => {
  if (!isJsonRecord(config)) return null
  const raw = config['until']
  if (typeof raw !== 'string') return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const buildNextScheduledRunAt = (input: {
  config: unknown
  from: Date
  now: Date
  type: AgentTriggerType
}): Date | null => {
  // One-off schedules fire exactly once. Returning null clears next_run_at so the
  // claim query (which requires next_run_at IS NOT NULL) never picks it up again.
  if (isOneOffConfig(input.config)) {
    return null
  }

  if (input.type === 'scheduled') {
    return withinScheduleEnd(
      computeNextCronRunAt({ config: input.config, currentDate: input.from }),
      input.config,
    )
  }

  if (input.type !== 'interval') {
    return input.from
  }

  const intervalMinutes = parseIntervalMinutes(input.config)
  if (!intervalMinutes) {
    return null
  }

  const base = input.from.getTime() > input.now.getTime() ? input.from : input.now
  return withinScheduleEnd(
    new Date(base.getTime() + intervalMinutes * 60_000),
    input.config,
  )
}

/**
 * Drop a computed fire time that falls past the schedule's end. Returning null
 * is the existing stop signal: it clears `next_run_at`, and the scheduler's
 * claim query requires that column to be non-null.
 */
const withinScheduleEnd = (next: Date | null, config: unknown): Date | null => {
  if (!next) return null
  const until = parseScheduleUntil(config)
  return until && next.getTime() > until.getTime() ? null : next
}

/**
 * Compute the first fire time for a freshly-created schedule. Returns null when
 * the config is invalid (bad cron, missing interval, malformed one-off date).
 */
export const computeInitialScheduleRunAt = (input: {
  config: unknown
  now: Date
  type: AgentTriggerType
}): Date | null => {
  if (isOneOffConfig(input.config)) {
    const at = isJsonRecord(input.config) ? input.config['at'] : undefined
    if (typeof at !== 'string') {
      return null
    }
    const parsed = new Date(at)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  if (input.type === 'scheduled') {
    return withinScheduleEnd(
      computeNextCronRunAt({ config: input.config, currentDate: input.now }),
      input.config,
    )
  }

  if (input.type === 'interval') {
    const intervalMinutes = parseIntervalMinutes(input.config)
    return withinScheduleEnd(
      intervalMinutes ? new Date(input.now.getTime() + intervalMinutes * 60_000) : null,
      input.config,
    )
  }

  return null
}

export const extractTriggerInstruction = (config: unknown): string | null => {
  if (!isJsonRecord(config)) {
    return null
  }
  const prompt = config['prompt']
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : null
}

/**
 * The user a scheduled run should act as. Only returns a well-formed UUID; a
 * malformed stored value degrades to null instead of throwing downstream.
 */
export const extractTriggerEffectiveUserId = (config: unknown): string | null => {
  if (!isJsonRecord(config)) {
    return null
  }
  const userId = config['createdByUserId']
  return typeof userId === 'string' && UUID_PATTERN.test(userId.trim())
    ? userId.trim()
    : null
}

/**
 * The immutable authenticated tenancy selected when a user creates a schedule.
 * Legacy configs deliberately return null: their original team cannot be
 * recovered safely from a system-owned agent or the eventual target channel.
 */
export const extractTriggerLaunchOrigin = (
  config: unknown,
): ScheduledTriggerLaunchOrigin | null => {
  if (!isJsonRecord(config)) {
    return null
  }

  const parsed = ScheduledTriggerLaunchOriginSchema.safeParse(config['launchOrigin'])
  return parsed.success ? parsed.data : null
}

/**
 * Build the seed message that drives a trigger-fired run. An explicit instruction
 * (from `prompt` or `config.prompt`) is used verbatim plus a memory nudge so the
 * agent does exactly what was asked and records findings; otherwise a generic
 * "trigger fired" message describes the payload.
 */
export const buildTriggerPrompt = (input: {
  config?: unknown
  payload: unknown
  prompt?: string
  source: string
  triggerType: AgentTriggerType
}): string => {
  const instruction = input.prompt?.trim() || extractTriggerInstruction(input.config)
  if (instruction) {
    return `${instruction}\n\n${MEMORY_NUDGE}`
  }

  // Model-facing only: the kickoff message is `system`, so it drives the run
  // but is never rendered in the channel. Phrased without an article because
  // the trigger type is interpolated ("A interval trigger" was the old bug).
  const prefix = `Trigger fired: ${input.triggerType} (source: ${input.source}).`
  if (input.payload === undefined) {
    return `${prefix}\n\nNo payload was provided.`
  }

  return `${prefix}\n\nPayload:\n${JSON.stringify(input.payload, null, 2)}`
}

/**
 * Capped exponential backoff: `baseMs * 2^attempt`, never above `capMs`.
 *
 * Only the curve is shared. The base, the cap, and any clamp on `attempt`
 * itself stay with the caller: they are that domain's retry policy, and a
 * clamped exponent is a different decision from a capped result — folding them
 * together here would hide which one a call site actually meant.
 */
export const exponentialBackoffMs = (input: {
  attempt: number
  baseMs: number
  capMs: number
}): number => Math.min(input.baseMs * 2 ** input.attempt, input.capMs)

// --- sp-webhook: trigger-delivery retry/backoff policy -----------------------
// Single source of truth for delivery retry math, shared by the API dispatch
// path (webhook intake) and the worker retry poller so the two never drift.
// Exponential backoff: BASE * 2^retryCount, capped at MAX_BACKOFF. After
// MAX_DELIVERY_RETRIES attempts a delivery is exhausted (nextRetryAt cleared).
export const DELIVERY_RETRY_BASE_MS = 30_000
export const DELIVERY_RETRY_MAX_BACKOFF_MS = 30 * 60_000
export const MAX_DELIVERY_RETRIES = 5

export const computeNextRetryAt = (
  retryCount: number,
  from: Date = new Date(),
): Date => {
  const backoff = exponentialBackoffMs({
    attempt: Math.max(0, retryCount),
    baseMs: DELIVERY_RETRY_BASE_MS,
    capMs: DELIVERY_RETRY_MAX_BACKOFF_MS,
  })
  return new Date(from.getTime() + backoff)
}
