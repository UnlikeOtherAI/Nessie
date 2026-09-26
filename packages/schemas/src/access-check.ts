import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

/**
 * Check access (plan §6.7, §10.13): for one agent, one account and one place
 * the agent could be asked from, the server answers each step the runtime
 * would take, in order, in words — and names the one step the viewer may take
 * to fix the first one that fails.
 *
 * The answer is composed from the runtime's own evaluators, never a second
 * copy of them; a refusal carries a reason code and a sentence, never another
 * person's account, a conversation the viewer cannot open, or an id the viewer
 * could not already see.
 */

const UUID = z.string().uuid()

/**
 * Where the agent is being asked from:
 * - `direct` — the viewer's own conversation with the agent (the viewer asks);
 * - `channel:<id>` — a conversation the viewer can open, asked by the viewer;
 * - `unattended` — a schedule or a trigger, with no person asking.
 */
export type AccessCheckContext =
  | { kind: 'direct' }
  | { kind: 'unattended' }
  | { kind: 'channel'; channelId: string }

export const parseAccessCheckContext = (value: string | undefined): AccessCheckContext | null => {
  if (value === undefined || value === 'direct') return { kind: 'direct' }
  if (value === 'unattended') return { kind: 'unattended' }
  if (!value.startsWith('channel:')) return null
  const channelId = UUID.safeParse(value.slice('channel:'.length))
  return channelId.success ? { channelId: channelId.data, kind: 'channel' } : null
}

export const formatAccessCheckContext = (context: AccessCheckContext): string =>
  context.kind === 'channel' ? `channel:${context.channelId}` : context.kind

/**
 * The steps, always in this order. A step that does not apply to an account's
 * kind is `skip`, so every answer reads the same way down the page.
 */
export const ACCESS_CHECK_STEP_IDS = [
  'account',
  'provider',
  'agent',
  'tools',
  'context',
  'policy',
] as const
export const AccessCheckStepIdSchema = z.enum(ACCESS_CHECK_STEP_IDS)
export type AccessCheckStepId = z.infer<typeof AccessCheckStepIdSchema>

export const AccessCheckOutcomeSchema = z.enum(['pass', 'fail', 'warn', 'skip'])
export type AccessCheckOutcome = z.infer<typeof AccessCheckOutcomeSchema>

/**
 * The one authorised remedy for a failed step. `code` names the act; `href`
 * is where the viewer does it, present only when the viewer may open it.
 */
export const AccessCheckRemedySchema = z.object({
  code: z.enum([
    'reconnect',
    'grant_capability',
    'unblock_capability',
    'allow_agent',
    'turn_on_tools',
    'choose_mailbox',
    'ask_owner',
    'ask_admin',
    'place_agent',
    'finish_setup',
  ]),
  label: NonEmptyStringSchema,
  href: z.string().nullable(),
})
export type AccessCheckRemedy = z.infer<typeof AccessCheckRemedySchema>

export const AccessCheckStepSchema = z.object({
  id: AccessCheckStepIdSchema,
  label: NonEmptyStringSchema,
  outcome: AccessCheckOutcomeSchema,
  reason: z.object({ code: NonEmptyStringSchema, sentence: NonEmptyStringSchema }),
  remedy: AccessCheckRemedySchema.nullable(),
})
export type AccessCheckStep = z.infer<typeof AccessCheckStepSchema>

/**
 * `allowed_with_approval` is a pass whose use still stops for a person —
 * every mailbox send, and a Google send without a standing permission.
 */
export const AccessCheckVerdictSchema = z.enum(['allowed', 'allowed_with_approval', 'refused'])
export type AccessCheckVerdict = z.infer<typeof AccessCheckVerdictSchema>

export const AccessCheckResultSchema = z.object({
  accountId: NonEmptyStringSchema,
  agentId: UUID,
  context: NonEmptyStringSchema,
  verdict: AccessCheckVerdictSchema,
  /** The verdict in one sentence. */
  summary: NonEmptyStringSchema,
  steps: z.array(AccessCheckStepSchema),
})
export type AccessCheckResult = z.infer<typeof AccessCheckResultSchema>

/**
 * The verdict the steps add up to: refused at the first failure, otherwise
 * allowed — with approval when a step warns that use stops for a person.
 */
export const accessCheckVerdict = (steps: readonly AccessCheckStep[]): AccessCheckVerdict => {
  if (steps.some((step) => step.outcome === 'fail')) return 'refused'
  return steps.some((step) => step.id === 'policy' && step.outcome === 'warn')
    ? 'allowed_with_approval'
    : 'allowed'
}
