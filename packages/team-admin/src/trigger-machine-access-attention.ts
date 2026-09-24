import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * "<trigger> needs machine access: ask the machines' owner to set it up, from
 * the trigger's page or the Agent Designer": the attention item a ticket
 * trigger an agent set up for someone leaves with that person
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
 * project-operator capability"). The agent acted as them, but machine access
 * stays the machines' owner's: no agent may set it up, so the person is told,
 * once per trigger, where to do it.
 *
 * A durable bell row and nothing else — no push, no realtime frame. That is
 * what lets the writer ship with the reader: an older replica never parses the
 * new kind, because nothing sends it one and its `visibleUserAlertWhere` has
 * no arm that would select the row. The row surfaces while the trigger's agent
 * is live, no standing policy for the trigger is preparing or live, and the
 * person can still open it (`packages/db/src/user-alerts.ts`).
 */
export const triggerMachineAccessEventKey = (triggerId: string): string =>
  `trigger-machine-access:${triggerId}`

export const raiseTriggerMachineAccessAttention = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    /** The agent that set the trigger up, named on the row. */
    actorAgentId: string | null
    organizationId: string
    projectId: string | null
    triggerId: string
    /** The person it was set up for. */
    userId: string
  },
): Promise<void> => {
  // `user_alerts` is unique on (user_id, event_key): one item per trigger, however often it is asked.
  await prisma.userAlert.createMany({
    data: [{
      actorAgentId: input.actorAgentId,
      eventKey: triggerMachineAccessEventKey(input.triggerId),
      kind: 'trigger_machine_access',
      organizationId: input.organizationId,
      projectId: input.projectId,
      triggerId: input.triggerId,
      userId: input.userId,
    }],
    skipDuplicates: true,
  })
}
