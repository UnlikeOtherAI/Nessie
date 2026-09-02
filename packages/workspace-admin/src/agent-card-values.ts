import { type AgentCardSpec } from '@nessie/schemas'

/**
 * Validating what a person submitted against the card the agent posted.
 *
 * Server-side and total: the client renders the same spec, but a press is an
 * API call and the browser is not the authority on which fields exist.
 */

export class AgentCardValueError extends Error {
  constructor(
    message: string,
    readonly fieldKeys: string[],
  ) {
    super(message)
    this.name = 'AgentCardValueError'
  }
}

export type ValidatedAgentCardSubmission = {
  values: Record<string, string | number | boolean>
  secrets: Record<string, string>
}

const coerce = (
  input: unknown,
  kind: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date',
  key: string,
  options: { value: string }[] | undefined,
): string | number | boolean => {
  if (kind === 'checkbox') {
    if (typeof input !== 'boolean') throw new AgentCardValueError(`"${key}" must be true or false.`, [key])
    return input
  }
  if (kind === 'number') {
    const numeric = typeof input === 'number' ? input : Number(input)
    if (!Number.isFinite(numeric)) throw new AgentCardValueError(`"${key}" must be a number.`, [key])
    return numeric
  }
  if (typeof input !== 'string') throw new AgentCardValueError(`"${key}" must be text.`, [key])
  const trimmed = input.trim()
  if (kind === 'select' && !(options ?? []).some((option) => option.value === trimmed)) {
    throw new AgentCardValueError(`"${key}" is not one of the offered options.`, [key])
  }
  if (kind === 'date' && Number.isNaN(Date.parse(trimmed))) {
    throw new AgentCardValueError(`"${key}" must be a date.`, [key])
  }
  return trimmed
}

/**
 * A `submits: false` action ignores inputs entirely — a half-filled form must
 * still be dismissable, which is the whole point of Cancel.
 */
export const validateAgentCardSubmission = (input: {
  spec: AgentCardSpec
  actionKey: string
  values: Record<string, unknown>
  secrets: Record<string, string>
}): ValidatedAgentCardSubmission => {
  const action = input.spec.actions.find((candidate) => candidate.key === input.actionKey)
  if (!action) throw new AgentCardValueError('That button is not on this card.', [])

  if (!action.submits) return { values: {}, secrets: {} }

  const inputBlocks = input.spec.blocks.flatMap((block) =>
    block.type === 'input' ? [block] : [],
  )
  const secretBlocks = input.spec.blocks.flatMap((block) =>
    block.type === 'secret' ? [block] : [],
  )

  const knownKeys = new Set([
    ...inputBlocks.map((block) => block.key),
    ...secretBlocks.map((block) => block.key),
  ])
  const unknown = [
    ...Object.keys(input.values),
    ...Object.keys(input.secrets),
  ].filter((key) => !knownKeys.has(key))
  if (unknown.length > 0) {
    throw new AgentCardValueError(`This card has no field named ${unknown.join(', ')}.`, unknown)
  }

  const values: Record<string, string | number | boolean> = {}
  const missing: string[] = []
  for (const block of inputBlocks) {
    const raw = input.values[block.key]
    const absent = raw === undefined || raw === null || raw === ''
    if (absent) {
      if (block.required) missing.push(block.key)
      continue
    }
    values[block.key] = coerce(raw, block.input, block.key, block.options)
  }

  const secrets: Record<string, string> = {}
  for (const block of secretBlocks) {
    const raw = input.secrets[block.key]
    // Every declared secret must be supplied on a submitting press: a card that
    // asks for a credential and stores nothing has silently failed its purpose.
    if (raw === undefined || raw.trim() === '') {
      missing.push(block.key)
      continue
    }
    secrets[block.key] = raw
  }

  if (missing.length > 0) {
    throw new AgentCardValueError(`Please fill in: ${missing.join(', ')}.`, missing)
  }

  return { values, secrets }
}
