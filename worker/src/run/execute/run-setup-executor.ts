import { carryForwardExecutorBindings, publishExecutorLeaseChanges } from '@nessie/executor-manage'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { buildExecutorToolset, type ExecutorToolset } from '../executor-toolset.js'
import type { ExecutionDependencies, RunContext } from './types.js'

type HostOutput = Parameters<typeof buildExecutorToolset>[1]['hostOutput']

/**
 * The run's executor bindings and the toolset over them, at run setup
 * (docs/executor-protocol/overview.md → "Binding"). Two doors, never both:
 *
 * - A ticket's work is bound by its standing policy, afresh at every wake,
 *   never by a lease: at the start of setup (`prepareTicketWorkRun`), before
 *   any tool is resolved, so a standing run is offered less.
 * - Any other run: a person's own follow-up in the conversation they launched
 *   local apps in is bound afresh here, immediately before the toolset reads
 *   the run's bindings. A refusal is an outcome, never a throw — and the carry
 *   runs for every agent's every turn, so an unexpected failure in it (a lost
 *   connection) must not sink an ordinary one either: the run goes on with
 *   whatever bindings it already has, and no reach facts are told.
 */
export const prepareRunExecutorToolset = async (
  deps: ExecutionDependencies,
  input: {
    context: RunContext
    hostOutput: HostOutput
    payload: RunExecuteJobPayload
    ticketWork: { workId: string } | null
    toolPolicy: Record<string, boolean> | null
  },
): Promise<ExecutorToolset> => {
  const { context, payload } = input
  const lease = input.ticketWork
    ? undefined
    : await carryForwardExecutorBindings(deps.prisma, { job: payload, runId: context.run.id })
      .catch((error: unknown) => {
        console.warn('[worker] executor lease carry failed for run', context.run.id, error)
        return undefined
      })
  context.executorLease = lease
  if (lease?.kind === 'carried') {
    // The carry moved the idle window the holder's composer shows. Only
    // the holder's own job carries, so the job's actor is the recipient.
    await publishExecutorLeaseChanges(deps.realtimeTransport, [{
      actorUserId: payload.actorContext.actor.actorId,
      id: lease.lease.id,
      organizationId: context.channel.organizationId,
      threadId: payload.threadId,
    }]).catch((error: unknown) => {
      console.warn('[worker] could not publish the executor lease notice for run', context.run.id, error)
    })
  }
  return buildExecutorToolset(deps.prisma, {
    agentId: context.agent.id,
    agentToolPolicy: input.toolPolicy,
    encryptionSecret: deps.executorCommandEncryptionSecret,
    hostOutput: input.hostOutput,
    organizationId: context.channel.organizationId,
    runId: context.run.id,
    ticketWork: context.ticketWorkMachine?.coding ?? null,
  })
}
