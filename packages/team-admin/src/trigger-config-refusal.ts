import type { ZodError } from 'zod'

/**
 * One field a trigger configuration was refused for: the path a person or a
 * model has to change, and why, in words that name what exists instead.
 */
export type TriggerConfigRefusal = {
  path: string
  reason: string
  /** The other trigger a one-pickup-per-column refusal is about. */
  triggerId?: string
}

/**
 * A typed trigger's configuration was refused, field by field.
 *
 * `createAgentTrigger` and `updateAgentTrigger` throw it for the types on the
 * typed config union (`AgentTriggerConfigInputSchema`); every other type keeps
 * answering null and the surfaces' generic sentence. The surfaces relay the
 * message as it is: the Triggers routes as a 400 `TRIGGER_CONFIG_REFUSED` with
 * the refusals as details, the agent tools as the tool's answer.
 */
export class TriggerConfigRefusalError extends Error {
  readonly code = 'TRIGGER_CONFIG_REFUSED'
  readonly refusals: readonly TriggerConfigRefusal[]

  constructor(refusals: readonly TriggerConfigRefusal[]) {
    super(refusals.map((refusal) => `${refusal.path}: ${refusal.reason}`).join('\n'))
    this.name = 'TriggerConfigRefusalError'
    this.refusals = refusals
  }
}

/** `pickup.columns[0].name`, the way the refusal names a field. */
export const formatConfigPath = (path: readonly (string | number)[], root = 'config'): string =>
  path.length === 0
    ? root
    : path.reduce<string>(
        (text, segment) => typeof segment === 'number' ? `${text}[${segment}]` : text ? `${text}.${segment}` : segment,
        '',
      )

/** A config's schema issues as refusals, one per issue, in the schema's own words. */
export const refusalsFromZodError = (error: ZodError): TriggerConfigRefusal[] =>
  error.issues.map((issue) => ({ path: formatConfigPath(issue.path), reason: issue.message }))
