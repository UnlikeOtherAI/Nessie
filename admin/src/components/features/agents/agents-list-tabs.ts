import type { AgentRecord } from '../../../lib/api-client'
import { getAgentScope, type AgentScope } from '../../shared/agent-scope'

/**
 * The Agents list's three tabs (docs/plans/2026-09-26-admin-ux-overhaul.md
 * §6.3): Mine · Shared · Built-in, in the URL as `?scope=`. Which tab an agent
 * sits on is the shared classification (`getAgentScope`) the channel members
 * list reads too, so the two can never sort an agent differently; only the
 * words are the list's.
 */
export const AGENT_LIST_TABS = ['mine', 'shared', 'built-in'] as const
export type AgentListTab = (typeof AGENT_LIST_TABS)[number]

const TAB_FOR_SCOPE: Record<AgentScope, AgentListTab> = {
  global: 'built-in',
  personal: 'mine',
  team: 'shared',
}

export const agentListTab = (agent: AgentRecord): AgentListTab => TAB_FOR_SCOPE[getAgentScope(agent)]

type AgentListTabCopy = {
  description: string
  empty: string
  label: string
}

export const AGENT_LIST_TAB_META: Record<AgentListTab, AgentListTabCopy> = {
  'built-in': {
    description:
      'Provided by Nessie. They are the same in every team and change only when Nessie is updated, '
      + 'so nobody edits them here; open one to see what it does and to talk to it.',
    empty: 'No built-in agents are available in this team.',
    label: 'Built-in',
  },
  mine: {
    description: 'Your Personal Assistant and the agents only you can see.',
    empty: 'You have no agents of your own yet. Create a private one with New agent.',
    label: 'Mine',
  },
  shared: {
    description: 'Agents that work in shared channels, built and run by your team.',
    empty: 'No shared agents yet. Create one to put an agent to work in your channels.',
    label: 'Shared',
  },
}
