import type { AgentRecord } from '../../../lib/api-client'

// The Agents page groups agents into three tabs. None of this is a new column:
// the scope is derived from fields the record already carries, so the tabs are
// real, not a stored flag that can drift from the agent's behaviour.
//
//  - `personal` — the Personal Assistant (`agentKind === 'personal_assistant'`),
//    the assistant that acts as its owner. Editable.
//  - `global`   — a system-provided agent (`systemManaged`, and not the PA):
//    librarian, external-agent products, and other bootstrapped agents. These
//    are not user-authored and are read-only, so the row omits its edit menu.
//  - `team`     — everything else: ordinary shared agents the workspace builds
//    and runs. Editable.
//
// Precedence matters: the PA is *both* `personal_assistant` and `systemManaged`,
// so kind is checked first to keep it in Personal rather than Global.
export type AgentScope = 'personal' | 'team' | 'global'

export const AGENT_SCOPES: readonly AgentScope[] = ['personal', 'team', 'global']

export const getAgentScope = (agent: AgentRecord): AgentScope => {
  if (agent.agentKind === 'personal_assistant') return 'personal'
  if (agent.systemManaged) return 'global'
  return 'team'
}

// Global agents are system-provided and cannot be edited from here.
export const isAgentScopeEditable = (scope: AgentScope): boolean =>
  scope !== 'global'

type AgentScopeCopy = {
  description: string
  empty: string
  label: string
}

export const AGENT_SCOPE_META: Record<AgentScope, AgentScopeCopy> = {
  personal: {
    description: 'Your Personal Assistant — it acts as you across the workspace.',
    empty: 'No personal assistant yet. Start a conversation with your assistant to set one up.',
    label: 'Personal agents',
  },
  team: {
    description: 'Shared agents your workspace builds, binds to channels, and runs.',
    empty: 'No team agents yet. Create one to put an agent to work in your channels.',
    label: 'Team agents',
  },
  global: {
    description: 'System-provided agents. These are managed for you and cannot be edited here.',
    empty: 'No global agents are available in this workspace.',
    label: 'Global agents',
  },
}
