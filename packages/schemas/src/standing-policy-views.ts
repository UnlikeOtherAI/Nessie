import { z } from 'zod'

import { ExecutorCodingMergeCommandSchema } from './executor-coding-sessions.js'
import { StandingPolicyMachineRefusalSchema } from './executor-standing-policy.js'
import {
  ExecutorStandingPolicyEndedReasonSchema,
  ExecutorStandingPolicyStatusSchema,
  ExecutorStandingPolicySuspendedReasonSchema,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
} from './ticket-work.js'

/**
 * What the screens read of standing machine access
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Screens";
 * docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * a ticket trigger's Machine access section, the machines its author may
 * offer, and an executor's Standing access panel. A machine is named only to
 * its author and the people who administer it; everyone else reads the state
 * and counts.
 */

const uuid = z.string().uuid()
const timestamp = z.string().datetime()

/** Where a trigger's machine access stands, as its section leads with it. */
export const TriggerMachineAccessStateSchema = z.enum([
  'not_set_up',
  'awaiting_confirmation',
  'live',
  'suspended',
  'ended',
])
export type TriggerMachineAccessState = z.infer<typeof TriggerMachineAccessStateSchema>

/** One machine of a policy's pool, named only to those who may know it. */
export const StandingPolicyMachineViewSchema = z
  .object({ executorId: uuid, label: z.string().min(1) })
  .strict()

/** One ticket the trigger's machine access is working, queueing or waiting on. */
export const TriggerMachineAccessTicketSchema = z
  .object({
    workId: uuid,
    taskId: uuid,
    projectId: uuid,
    /** The ticket's own key and title, as its work thread is named. */
    title: z.string().min(1),
    status: TicketWorkStatusSchema,
    stateReason: TicketWorkStateReasonSchema.nullable(),
    /** Its place while `queued`. */
    position: z.number().int().positive().nullable(),
    /** The machine it holds: only for the author and the machine's administrators. */
    machineLabel: z.string().min(1).nullable(),
  })
  .strict()
export type TriggerMachineAccessTicket = z.infer<typeof TriggerMachineAccessTicketSchema>

/** `GET /api/triggers/:triggerId/machine-access`. */
export const TriggerMachineAccessViewSchema = z
  .object({
    triggerId: uuid,
    state: TriggerMachineAccessStateSchema,
    /** The trigger's author: the only person who can set it up. */
    author: z.object({ userId: uuid, name: z.string().min(1) }).strict().nullable(),
    viewerIsAuthor: z.boolean(),
    /** The policy this section speaks for: the binding one, else the card still out, else the last ended. */
    policy: z
      .object({
        id: uuid,
        status: ExecutorStandingPolicyStatusSchema,
        suspendedReason: ExecutorStandingPolicySuspendedReasonSchema.nullable(),
        endedReason: ExecutorStandingPolicyEndedReasonSchema.nullable(),
        endedAt: timestamp.nullable(),
        endedByName: z.string().min(1).nullable(),
        confirmedAt: timestamp.nullable(),
        createdAt: timestamp,
        machineCount: z.number().int().min(1).max(2),
        /** Named only to the author and the machines' administrators; null for anyone else. */
        machines: z.array(StandingPolicyMachineViewSchema).max(2).nullable(),
        limits: z
          .object({ dailyUsd: z.number().positive(), ticketHours: z.number().positive(), ticketUsd: z.number().positive() })
          .strict()
          .nullable(),
        allowAnyCommand: z.boolean().nullable(),
        /** The author, or an administrator of one of its machines, may end it. */
        viewerCanEnd: z.boolean(),
      })
      .strict()
      .nullable(),
    /** A card prepared and not yet confirmed, beside a policy that still binds. */
    pendingCard: z.object({ policyId: uuid, createdAt: timestamp }).strict().nullable(),
    /** Every live ticket of the trigger: working, queued, waiting or parked. */
    tickets: z.array(TriggerMachineAccessTicketSchema).max(50),
  })
  .strict()
export type TriggerMachineAccessView = z.infer<typeof TriggerMachineAccessViewSchema>

/**
 * `GET /api/triggers/:triggerId/machine-access/machines`, for the author's
 * setup form: each private machine they paired, whether it can take the work,
 * and the facts the form re-checks as the author changes the options (the
 * bypass tick, `ticketUsd`, the roots). The server's prepare re-checks all of
 * it.
 */
export const StandingPolicyMachineOptionSchema = z
  .object({
    executorId: uuid,
    label: z.string().min(1),
    /** Refused whatever the author chooses, and why. */
    refusal: z.object({ reason: StandingPolicyMachineRefusalSchema, sentence: z.string().min(1) }).strict().nullable(),
    /** The reviewed coding facts, when the machine offers them. */
    facts: z
      .object({
        rootNames: z.array(z.string().min(1)),
        permissionMode: z.string().min(1),
        turnBudgetUsd: z.number().positive().nullable(),
        maxLiveSessionsPerOwner: z.number().int().min(1).nullable(),
        mergeCommands: z.array(ExecutorCodingMergeCommandSchema),
      })
      .strict()
      .nullable(),
  })
  .strict()
export type StandingPolicyMachineOption = z.infer<typeof StandingPolicyMachineOptionSchema>

export const StandingPolicyMachineOptionsResponseSchema = z
  .object({ machines: z.array(StandingPolicyMachineOptionSchema).max(50) })
  .strict()
export type StandingPolicyMachineOptionsResponse = z.infer<typeof StandingPolicyMachineOptionsResponseSchema>

/** One row of an executor's Standing access panel. */
export const ExecutorStandingPolicyRowSchema = z
  .object({
    id: uuid,
    status: ExecutorStandingPolicyStatusSchema,
    suspendedReason: ExecutorStandingPolicySuspendedReasonSchema.nullable(),
    trigger: z.object({ id: uuid, name: z.string().min(1) }).strict().nullable(),
    agentName: z.string().min(1).nullable(),
    authorName: z.string().min(1),
    confirmedAt: timestamp.nullable(),
    createdAt: timestamp,
    /** Tickets working on this machine under it now. */
    activeTickets: z.number().int().min(0),
    viewerCanEnd: z.boolean(),
  })
  .strict()
export type ExecutorStandingPolicyRow = z.infer<typeof ExecutorStandingPolicyRowSchema>

/** `GET /api/executors/:executorId/standing-policies`: every policy not yet ended whose pool names it. */
export const ExecutorStandingPolicyListResponseSchema = z
  .object({ policies: z.array(ExecutorStandingPolicyRowSchema).max(100) })
  .strict()
export type ExecutorStandingPolicyListResponse = z.infer<typeof ExecutorStandingPolicyListResponseSchema>

/** `POST /api/standing-policies/:policyId/end`. */
export const EndStandingPolicyResponseSchema = z.object({ ended: z.boolean() }).strict()
export type EndStandingPolicyResponse = z.infer<typeof EndStandingPolicyResponseSchema>
