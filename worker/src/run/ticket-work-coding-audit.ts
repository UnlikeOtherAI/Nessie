import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { TicketWorkKickoffMetadataSchema } from '@nessie/schemas'

import type { TicketWorkCodingScope } from './ticket-work-coding-sessions.js'

/**
 * The coding sessions of a ticket's work on the audit chain
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Audit"):
 * a start and a close tagged with the ticket and the policy's owner context,
 * and each `coding_session_send` with what it forwarded — the events that
 * woke its run, and who wrote each — so a merge traces back to the member
 * who asked for it. Writing one never fails the call it describes.
 */

type Action = 'executor.coding_session.started' | 'executor.coding_session.closed' | 'executor.coding_session.sent'

/** The events the run's kickoff told of, by source and author — never their text. */
const forwardedEvents = async (prisma: Pick<PrismaClient, 'run'>, runId: string) => {
  const run = await prisma.run.findUnique({
    where: { id: runId }, select: { triggerMessage: { select: { id: true, metadata: true } } },
  })
  const metadata = run?.triggerMessage?.metadata
  const kickoff = TicketWorkKickoffMetadataSchema.safeParse(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)['ticketWorkKickoff']
      : undefined,
  )
  return {
    kickoffMessageId: run?.triggerMessage?.id ?? null,
    events: kickoff.success
      ? kickoff.data.events.map((event) => ({
          at: event.at, by: event.by ?? null, reason: event.reason, source: event.source ?? null,
        }))
      : [],
  }
}

export const writeTicketWorkCodingAudit = async (
  prisma: PrismaClient,
  scope: TicketWorkCodingScope,
  input: { action: Action; sessionId: string },
): Promise<void> => {
  try {
    const forwarded = input.action === 'executor.coding_session.sent' ? await forwardedEvents(prisma, scope.runId) : null
    await prisma.$transaction(async (tx) => {
      await writeAuditEntryInTransaction(tx, {
        action: input.action,
        actorId: scope.agentId,
        actorType: 'agent',
        metadata: {
          contextId: scope.contextId,
          executorId: scope.executorId,
          policyId: scope.policyId,
          runId: scope.runId,
          taskId: scope.taskId,
          workId: scope.workId,
          ...(input.action === 'executor.coding_session.started' ? { title: scope.title } : {}),
          ...(forwarded ? { forwarded: forwarded.events, kickoffMessageId: forwarded.kickoffMessageId } : {}),
        } as Prisma.InputJsonValue,
        organizationId: scope.organizationId,
        outcome: 'success',
        requestId: `ticket-work:${scope.workId}:${scope.runId}:${input.sessionId}:${input.action}`,
        resourceId: input.sessionId,
        resourceType: 'executor_coding_session',
      })
    })
  } catch (error) {
    console.warn('[ticket-work] could not audit', input.action, 'for session', input.sessionId, error)
  }
}
