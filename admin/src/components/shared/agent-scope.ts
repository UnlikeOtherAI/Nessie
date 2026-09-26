import type { AgentRecord } from '../../lib/api-client'

// Which of three kinds an agent is — the Agents list's Mine, Shared and Built-in
// tabs (`features/agents/agents-list-tabs.ts`) and the channel members list both
// read it. None of this is a new column: the scope is derived from fields the
// record already carries, so it is real, not a stored flag that can drift from
// the agent's behaviour.
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

export const getAgentScope = (agent: AgentRecord): AgentScope => {
  if (agent.agentKind === 'personal_assistant') return 'personal'
  if (agent.systemManaged) return 'global'
  if (agent.visibility === 'private') return 'personal'
  return 'team'
}

// Global agents are system-provided and cannot be edited from here.
export const isAgentScopeEditable = (scope: AgentScope): boolean =>
  scope !== 'global'
