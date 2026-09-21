import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseOrganizationId, parseTaskId } from '@nessie/schemas'

type Transport = Pick<PgRealtimeTransport, 'publishWs'>

const organizationScope = (organizationId: string) => ({
  kind: 'organization' as const,
  organizationId: parseOrganizationId(organizationId),
})

/**
 * A ticket's comments or files changed. Content-free — ids only, on the
 * organisation scope, inside the unchanged envelope — so the client's refetch
 * is the entitlement check and a replica or client that predates the name
 * ignores it (the `board.updated` precedent). A projectless task has no board
 * to repaint and no `projectId` to name, so it publishes nothing.
 */
export const publishTaskActivity = async (
  transport: Transport,
  input: { organizationId: string; taskId: string; projectId: string | null },
): Promise<void> => {
  if (!input.projectId) return
  await transport.publishWs([organizationScope(input.organizationId)], {
    event: 'task.activity',
    data: { taskId: parseTaskId(input.taskId), projectId: input.projectId },
  })
}

/** A project's labels changed name or colour, so every card repaints. */
export const publishProjectBoardUpdated = async (
  transport: Transport,
  input: { organizationId: string; projectId: string },
): Promise<void> => {
  await transport.publishWs([organizationScope(input.organizationId)], {
    event: 'board.updated',
    data: { projectId: input.projectId },
  })
}
