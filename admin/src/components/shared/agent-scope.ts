import type { AgentRecord } from '../../lib/api-client'

// The Agents page groups agents into three tabs. None of this is a new column:
// the scope is derived from fields the record already carries, so the tabs are
// real, not a stored flag that can drift from the agent's behaviour.
//
//  - `personal` — the Personal Assistant (`agentKind === 'personal_assistant'`)
//    plus private agents (`visibility === 'private'`). Editable.
//  - `global`   — a system-provided agent (`systemManaged`, and not the PA):
//    librarian, external-agent products, and other bootstrapped agents. These
//    are not user-authored and are read-only, so the row omits its edit menu.
//  - `team`     — everything else: team-visible agents the team
//    builds and runs. Editable.
//
// Precedence matters: the PA is *both* `personal_assistant` and `systemManaged`,
// so kind is checked first to keep it in Personal rather than Global.
export type AgentScope = 'personal' | 'team' | 'global'

export const AGENT_SCOPES: readonly AgentScope[] = ['personal', 'team', 'global']

export const getAgentScope = (agent: AgentRecord): AgentScope => {
  if (agent.agentKind === 'personal_assistant') return 'personal'
  if (agent.systemManaged) return 'global'
  if (agent.visibility === 'private') return 'personal'
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
    description: 'Your Personal Assistant and agents only you can see.',
    empty: 'No personal agents yet. Start a conversation with your assistant or create a private agent.',
    label: 'Personal agents',
  },
  team: {
    description: 'Shared agents your team builds, binds to channels, and runs.',
    empty: 'No team agents yet. Create one to put an agent to work in your channels.',
    label: 'Team agents',
  },
  global: {
    description: 'System-provided agents. These are managed for you and cannot be edited here.',
    empty: 'No global agents are available in this team.',
    label: 'Global agents',
  },
}
