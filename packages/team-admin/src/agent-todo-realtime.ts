import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
} from '@nessie/schemas'

type TodoRealtimeTransport = Pick<import('@nessie/runtime').PgRealtimeTransport, 'publishWs'>

/**
 * To-do state is private to the agent entitlement read. The event intentionally
 * contains identifiers only; every receiver re-fetches through that gate.
 */
export const publishAgentTodoUpdated = async (
  transport: TodoRealtimeTransport,
  input: {
    agentId: string
    channelId?: string
    organizationId: string
    todoId: string
  },
): Promise<void> => {
  await transport.publishWs([
    { kind: 'organization', organizationId: parseOrganizationId(input.organizationId) },
    { kind: 'agent', agentId: parseAgentId(input.agentId) },
    ...(input.channelId
      ? [{ kind: 'channel' as const, channelId: parseChannelId(input.channelId) }]
      : []),
  ], {
    data: { agentId: parseAgentId(input.agentId), todoId: input.todoId },
    event: 'agent.todo.updated',
  })
}
