import type { Prisma } from '@prisma/client'
import {
  StandingPolicyHostProfileSchema,
  TICKET_WORK_PURPOSE,
  ticketWorkCodingSessionContext,
} from '@nessie/schemas'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

/**
 * The dispatch fence of a binding made under a standing policy, beside
 * `assertExecutorCommandBindingCurrent` (docs/standards/ticket-work-machine-access.md
 * → "The machine owner's authority is read only by the standing-policy
 * binder"). Every command such a binding carries, as it is created and again
 * as the daemon collects it, needs all of this to still hold, under the
 * executor lock every policy transition and every fence takes:
 *
 * - the policy is `live`, names this machine in its pool, and its author and
 *   agent are the ones the binding's candidate was made for;
 * - the work record is still `active`, pinned to this machine under this
 *   policy, and the run is in its thread.
 *
 * It takes the place of the trigger-author check an ordinary binding gets: a
 * `ticket.work` run's trigger is the platform's kickoff, which no person
 * wrote. And it names the coding-session owner's context — the ticket's own,
 * never anything the run sent.
 */

export type StandingBindingRef = {
  executorId: string
  runId: string
  standingPolicyId: string | null
  ticketWorkId: string | null
}

export const isStandingBinding = (binding: Pick<StandingBindingRef, 'standingPolicyId' | 'ticketWorkId'>): boolean =>
  Boolean(binding.standingPolicyId || binding.ticketWorkId)

const fenced = (message: string): ExecutorError => new ExecutorError(EXECUTOR_ERROR_CODES.BINDING_FENCED, message)

export const assertStandingPolicyBindingCurrent = async (
  tx: Prisma.TransactionClient,
  binding: StandingBindingRef,
  candidate: { actorUserId: string; agentId: string },
): Promise<{ contextId: string }> => {
  if (!binding.standingPolicyId || !binding.ticketWorkId) {
    throw fenced('The machine access this binding was made under is gone.')
  }
  const [policy, work, run] = await Promise.all([
    tx.executorStandingPolicy.findUnique({
      where: { id: binding.standingPolicyId },
      select: {
        agentId: true, authorUserId: true, status: true,
        executors: { where: { executorId: binding.executorId }, select: { executorId: true } },
      },
    }),
    tx.agentTicketWork.findUnique({
      where: { id: binding.ticketWorkId },
      select: { agentId: true, executorId: true, policyId: true, status: true, taskId: true, threadId: true },
    }),
    tx.run.findUnique({ where: { id: binding.runId }, select: { agentId: true, threadId: true } }),
  ])
  if (!policy || policy.status !== 'live' || policy.executors.length === 0
    || policy.authorUserId !== candidate.actorUserId || policy.agentId !== candidate.agentId) {
    throw fenced('The machine access this ticket\'s work runs under is no longer live.')
  }
  if (!work || work.status !== 'active' || work.executorId !== binding.executorId
    || work.policyId !== binding.standingPolicyId || work.agentId !== candidate.agentId
    || !run || run.agentId !== candidate.agentId || run.threadId !== work.threadId) {
    throw fenced('This ticket\'s work no longer holds this machine.')
  }
  return { contextId: ticketWorkCodingSessionContext(binding.standingPolicyId, work.taskId) }
}

/**
 * The owner context a binding pins, read as the command's payload is checked:
 * the ticket's, for a standing binding whose record and policy are there; none
 * for any other binding.
 */
export const standingBindingContextId = async (
  client: Pick<Prisma.TransactionClient, 'agentTicketWork'>,
  binding: Pick<StandingBindingRef, 'standingPolicyId' | 'ticketWorkId'>,
): Promise<string | undefined> => {
  if (!binding.standingPolicyId || !binding.ticketWorkId) return undefined
  const work = await client.agentTicketWork.findUnique({
    where: { id: binding.ticketWorkId }, select: { taskId: true },
  })
  return work ? ticketWorkCodingSessionContext(binding.standingPolicyId, work.taskId) : undefined
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/**
 * The host profile's own rule for a start, on the server, whatever the worker
 * offered: a standing binding's `session_start` names one of the policy's
 * coding agents and one of its allowed roots, or it is refused before a
 * command exists. Null when the payload is not such a start, or passes.
 */
export const standingStartRefusal = async (
  client: Pick<Prisma.TransactionClient, 'executorStandingPolicy'>,
  binding: Pick<StandingBindingRef, 'standingPolicyId'>,
  payload: Record<string, unknown>,
): Promise<string | null> => {
  const args = record(payload.args)
  if (!binding.standingPolicyId || args?.tool !== 'session_start') return null
  const policy = await client.executorStandingPolicy.findUnique({
    where: { id: binding.standingPolicyId }, select: { hostProfile: true },
  })
  const profile = StandingPolicyHostProfileSchema.safeParse(policy?.hostProfile)
  const start = record(args.arguments)
  if (!profile.success) return 'The machine access this start runs under no longer states what it allows.'
  if (!profile.data.codingAgents.some((agent) => agent === start?.agent)) {
    return 'Ticket work may start only the coding agents its machine access names.'
  }
  if (!profile.data.allowedRootNames.some((root) => root === start?.root)) {
    return 'Ticket work may start a coding agent only in the roots its machine access allows.'
  }
  return null
}

/** A `ticket.work` job's own claim to serve this record, as its actor context states it. */
export const jobServesTicketWork = (
  job: {
    actorContext: {
      actor: { actorId: string; actorType: string }
      actionContext: { purpose?: string; ticketWorkId?: string }
    }
  },
  work: { agentId: string; id: string },
): boolean => job.actorContext.actionContext.purpose === TICKET_WORK_PURPOSE
  && job.actorContext.actionContext.ticketWorkId === work.id
  && job.actorContext.actor.actorType === 'agent'
  && job.actorContext.actor.actorId === work.agentId
