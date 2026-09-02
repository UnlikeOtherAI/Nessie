import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { useAgents } from '../facades/agents/hooks'
import { usePersonalAssistant } from '../facades/personal-assistant/hooks'
import type { AgentIdentity } from '../components/shared/agent-identity'

type AgentIdentityContextValue = {
  lookup: (agentId?: string | null) => AgentIdentity | null
}

const AgentIdentityContext = createContext<AgentIdentityContextValue | null>(null)

/**
 * The directory that answers "what does this agent look like" from an id alone.
 *
 * It exists because the picture and the list were resolved by different
 * queries. `GET /api/agents` deliberately omits `systemManaged` agents, so the
 * Personal Assistant was absent from the `agentMap` every message row consults
 * — and `AgentAvatar` fell through to its `⚡` placeholder for the one agent
 * almost every person talks to, while the sidebar (fed by the PA facade) showed
 * its real portrait two panels away. Any surface that resolved an agent through
 * a narrower projection had the same hole.
 *
 * So the identity of an agent is looked up here and nowhere else. It is
 * deliberately identity-only — name, role, picture — and never a second agent
 * list: pickers, bindings and policy surfaces keep reading `useAgents()`, which
 * still excludes system agents. Nothing here widens what a caller may *do*
 * with an agent, only what it may draw.
 */
export const AgentIdentityProvider = ({ children }: { children: ReactNode }) => {
  // `scope=all` is a strict superset of the default list: the same entitled
  // agents plus the read-only system tier (the Personal Assistant, and global
  // agents such as the Agent Designer). The directory has to answer for those
  // too — a global agent owns a per-user DM and posts into it, so every message
  // row, sidebar entry and participant chip needs its picture from its id
  // alone. It stays identity-only; pickers, bindings and policy surfaces keep
  // reading `useAgents()`, which still excludes system agents.
  const { data: agents = [] } = useAgents({ scope: 'all' })
  // Unconditional: the directory has to answer for the Personal Assistant on
  // every surface, not only the ones that happen to be showing its channel.
  const { data: personalAssistant } = usePersonalAssistant()

  const value = useMemo<AgentIdentityContextValue>(() => {
    const byId = new Map<string, AgentIdentity>()
    for (const agent of agents) {
      byId.set(agent.id, agent)
    }
    if (personalAssistant?.agent) {
      byId.set(personalAssistant.agent.id, personalAssistant.agent)
    }
    return {
      lookup: (agentId?: string | null) => (agentId ? byId.get(agentId) ?? null : null),
    }
  }, [agents, personalAssistant?.agent])

  return <AgentIdentityContext.Provider value={value}>{children}</AgentIdentityContext.Provider>
}

/**
 * The directory entry for an agent id, or null. Outside the provider (tests,
 * logged-out screens) it answers null rather than throwing, so an avatar keeps
 * rendering from whatever the caller already holds.
 */
export const useAgentIdentity = (agentId?: string | null): AgentIdentity | null => {
  const context = useContext(AgentIdentityContext)
  return context?.lookup(agentId) ?? null
}
