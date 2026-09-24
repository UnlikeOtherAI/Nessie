import { z } from 'zod'

import { AgentCardSpecSchema } from './agent-card.js'
import {
  CodingRootNameSchema,
  ExecutorCodingAgentNameSchema,
  ExecutorCodingMergeCommandSchema,
} from './executor-coding-sessions.js'
import { TicketEndOnSchema, TicketFollowKindSchema } from './ticket-triggers.js'

/**
 * Standing machine access: what a trigger's author agrees to once, with fresh
 * verification, so that a colleague's move of a ticket can have a coding agent
 * work it on the author's own paired machines
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md,
 * docs/standards/ticket-work.md). The policy row and its pool are T0's
 * (`executor_standing_policies`, `executor_standing_policy_executors`); these
 * are the shapes of what the row pins and of the one confirmation that makes
 * it live.
 */

const uuid = z.string().uuid()

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length

/** What one ticket's work, and one policy's day, may spend, as a person may set it. */
export const STANDING_POLICY_LIMIT_DEFAULTS = { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 } as const

/** The platform ceiling each limit is held to, whatever a person asks for. */
export const STANDING_POLICY_LIMIT_CEILINGS = { dailyUsd: 1_000, ticketHours: 48, ticketUsd: 200 } as const

// Coerced: a model or a form may send "20" for 20, and a limit is only ever a number.
export const StandingPolicyLimitsSchema = z
  .object({
    ticketHours: z.coerce
      .number()
      .positive()
      .max(STANDING_POLICY_LIMIT_CEILINGS.ticketHours)
      .default(STANDING_POLICY_LIMIT_DEFAULTS.ticketHours)
      .describe('Hours one ticket\'s work may stay active, not counting time it waits for a machine or a person.'),
    ticketUsd: z.coerce
      .number()
      .positive()
      .max(STANDING_POLICY_LIMIT_CEILINGS.ticketUsd)
      .default(STANDING_POLICY_LIMIT_DEFAULTS.ticketUsd)
      .describe(
        'US dollars one ticket\'s coding may spend. Each machine\'s per-turn budget must not exceed it, '
        + 'so a ticket overshoots it by at most one turn.',
      ),
    dailyUsd: z.coerce
      .number()
      .positive()
      .max(STANDING_POLICY_LIMIT_CEILINGS.dailyUsd)
      .default(STANDING_POLICY_LIMIT_DEFAULTS.dailyUsd)
      .describe('US dollars all of this trigger\'s ticket work may spend in one day.'),
  })
  .strict()
  .default({})
  .describe('What the work may spend. Raising a limit later takes a new confirmation; lowering one does not.')
export type StandingPolicyLimits = z.infer<typeof StandingPolicyLimitsSchema>

/**
 * The agent's definition as the author agreed to it: a digest of its
 * instructions, model, tool policy and connectors, with the provider and model
 * the card shows (`loadStandingPolicyAgentPin`, executor-manage).
 */
export const StandingPolicyAgentPinSchema = z
  .object({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
  })
  .strict()
export type StandingPolicyAgentPin = z.infer<typeof StandingPolicyAgentPinSchema>

/**
 * The trigger's security-relevant fields, as the author agreed to them, the
 * agent's definition, and every limit. `triggerDigest` is the digest of
 * exactly this object, so the binder can recompute it from the live trigger,
 * and a fresh card can show which of them changed. Lists are sorted, so an edit that only reorders
 * changes nothing.
 */
export const StandingPolicyPinnedTermsSchema = z
  .object({
    agentId: uuid,
    agent: StandingPolicyAgentPinSchema,
    targetChannelId: uuid,
    boardId: uuid,
    pickupColumnIds: z.array(uuid),
    assignOnPickup: z.boolean(),
    followKinds: z.array(TicketFollowKindSchema),
    includeSourceEvents: z.boolean(),
    endOn: z.array(TicketEndOnSchema),
    /** Every instructions section, verbatim, by its key. */
    instructions: z.record(z.string(), z.string()),
    /** Minutes of quiet before a quiet wake; null when the trigger turned it off. */
    quietWakeMinutes: z.number().int().positive().nullable(),
    limits: z
      .object({
        wakesPerTicket: z.number().int().min(1),
        startsPerDay: z.number().int().min(1),
        ticketHours: z.number().positive(),
        ticketUsd: z.number().positive(),
        dailyUsd: z.number().positive(),
      })
      .strict(),
  })
  .strict()
export type StandingPolicyPinnedTerms = z.infer<typeof StandingPolicyPinnedTermsSchema>

/** One pool machine as the card showed it and every start checks it. */
export const StandingPolicyHostMachineSchema = z
  .object({
    executorId: uuid,
    label: z.string().min(1).max(200),
    /** Claude Code's reviewed `--permission-mode` on that machine. */
    permissionMode: z.string().min(1).max(64),
    /** Claude Code's signed per-turn budget there: required, and at most `ticketUsd`. */
    maxBudgetUsd: z.number().positive(),
    maxLiveSessionsPerOwner: z.number().int().min(1),
    /** Which pull-request commands it may run unasked; fewer than four stops a ticket at an open pull request. */
    mergeCommands: z.array(ExecutorCodingMergeCommandSchema),
    /**
     * The machine's signed `unaskedCommands`: `any` when Claude Code there may
     * run any command without asking, which the author's tick allowed.
     * Optional only for policies confirmed before it was pinned.
     */
    unaskedCommands: z.enum(['any', 'listed']).optional(),
  })
  .strict()
export type StandingPolicyHostMachine = z.infer<typeof StandingPolicyHostMachineSchema>

/**
 * The reviewed unattended host profile: the coding agents a start may use
 * (only one whose turn has a budget, so today only Claude Code), whether the
 * author let it run any command without asking, the coding roots a start may
 * name, and each machine's pinned facts.
 */
export const StandingPolicyHostProfileSchema = z
  .object({
    codingAgents: z.array(ExecutorCodingAgentNameSchema).min(1),
    allowAnyCommand: z.boolean(),
    allowedRootNames: z.array(CodingRootNameSchema).min(1).max(16).refine(distinct),
    machines: z.array(StandingPolicyHostMachineSchema).min(1).max(2),
  })
  .strict()
export type StandingPolicyHostProfile = z.infer<typeof StandingPolicyHostProfileSchema>

/** The option that lets a coding agent in a bypass mode work tickets, worded as the card and the tool word it. */
export const STANDING_POLICY_ANY_COMMAND_OPTION = 'Let the coding agent run any command without asking.'

/**
 * What `executor_standing_policy_prepare` and the trigger's Machine access
 * section send: the trigger, one or two machines, the host profile choices and
 * the policy's limits. The trigger's own `wakesPerTicket` and `startsPerDay`
 * stay on the trigger.
 */
export const ExecutorStandingPolicyPrepareInputSchema = z
  .object({
    triggerId: uuid.describe('The ticket trigger whose work the machines take, from agent_trigger_create or its page.'),
    executorIds: z
      .array(uuid)
      .min(1)
      .max(2)
      .refine(distinct, 'Name each machine once.')
      .describe('One or two machines you paired as private executors with a reviewed coding-sessions bridge.'),
    allowAnyCommand: z
      .boolean()
      .default(false)
      .describe(
        `${STANDING_POLICY_ANY_COMMAND_OPTION} Only the person asking may choose it; without it a machine whose `
        + 'Claude Code runs in bypassPermissions is refused.',
      ),
    allowedRootNames: z
      .array(CodingRootNameSchema)
      .min(1)
      .max(16)
      .refine(distinct, 'Name each coding root once.')
      .optional()
      .describe('The coding roots ticket work may use. Left out: every root all the machines share.'),
    limits: StandingPolicyLimitsSchema,
  })
  .strict()
export type ExecutorStandingPolicyPrepareInput = z.infer<typeof ExecutorStandingPolicyPrepareInputSchema>

/** Why one machine cannot take a trigger's ticket work, as prepare says it per machine. */
export const StandingPolicyMachineRefusalSchema = z.enum([
  'not_found',
  'not_private',
  'paired_by_someone_else',
  'not_administrator',
  'no_reviewed_coding_sessions',
  'offline',
  'older_executor',
  'no_turn_budget',
  'turn_budget_above_ticket',
  'bypass_not_allowed',
  'root_missing',
])
export type StandingPolicyMachineRefusal = z.infer<typeof StandingPolicyMachineRefusalSchema>

/**
 * The prepared change a standing policy's one confirmation carries, in the
 * executor access-change continuation beside the per-machine kinds. The
 * preparing policy row holds everything the card showed; this names it, pins
 * each machine's authorization revision, and says in a few words what it is
 * for a review opened with nothing else on screen.
 */
export const ExecutorStandingPolicyAccessChangeSchema = z
  .object({
    kind: z.literal('standing_policy'),
    policyId: uuid,
    triggerId: uuid,
    agentId: uuid,
    executors: z
      .array(z.object({ executorId: uuid, authorizationRevision: z.number().int().min(0) }).strict())
      .min(1)
      .max(2),
    summary: z
      .object({ triggerName: z.string().min(1).max(200), machineLabels: z.array(z.string().min(1).max(200)).min(1) })
      .strict(),
  })
  .strict()
export type ExecutorStandingPolicyAccessChange = z.infer<typeof ExecutorStandingPolicyAccessChangeSchema>

/**
 * The coding-session owner context of one ticket's work under one policy
 * (`ExecutorCodingSessionOwnerContextSchema`): what isolates its sessions
 * from the author's own and every other ticket's, and what a close names them
 * by. Lowercase, because the owner key hashes the text.
 */
export const ticketWorkCodingSessionContext = (policyId: string, taskId: string): string =>
  `ticket:${policyId.toLowerCase()}:${taskId.toLowerCase()}`

/** What the trigger's Machine access section sends: the prepare input, its trigger named by the address. */
export const PrepareStandingPolicyBodySchema = ExecutorStandingPolicyPrepareInputSchema.omit({ triggerId: true })
export type PrepareStandingPolicyBody = z.infer<typeof PrepareStandingPolicyBodySchema>

/**
 * A prepared standing policy, answered to its author's own browser: the
 * change to confirm with their password, its token (a person's own session
 * may hold it; no model ever does), and the card that says in plain words
 * what they would agree to, for the section to render as the chat renders it.
 */
export const PreparedStandingPolicyResponseSchema = z
  .object({
    accessChangeId: uuid,
    card: AgentCardSpecSchema,
    confirmationToken: z.string().min(32),
    expiresAt: z.string().datetime(),
    policyId: uuid,
    requiresFreshVerification: z.literal(true),
  })
  .strict()
export type PreparedStandingPolicyResponse = z.infer<typeof PreparedStandingPolicyResponseSchema>
