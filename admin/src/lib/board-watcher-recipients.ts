import type { AgentRecord } from './api-client'

/**
 * Agents an administrator may add to a board watcher list.
 *
 * This is deliberately different from the New-message address book: a board
 * watcher needs a conversation that can receive a worker wake. System agents
 * and the Personal Assistant have fixed homes, while an ordinary team agent or
 * the current person's private agent can be given the board's captured home.
 */
export const selectBoardWatcherAgents = (
  agents: AgentRecord[],
  currentUserId: string | null | undefined,
): AgentRecord[] =>
  agents.filter(
    (agent) =>
      agent.systemManaged !== true
      && !agent.systemSlug
      && agent.agentKind !== 'personal_assistant'
      && (
        agent.visibility === 'team'
        || (Boolean(currentUserId) && agent.ownerUserId === currentUserId)
      ),
  )
