import type { WorkspaceMemberRecord } from '@nessie/schemas'
import type { AgentRecord } from '../../../lib/api-client'

/**
 * The people-and-their-agents tree, computed at read time from two reads that
 * are each already scoped to what the viewer may see: UOA's live roster, and
 * `GET /api/agents`, whose entitlement rules this inherits rather than restates.
 *
 * There is no stored hierarchy anywhere. People, names, roles and lifecycle come
 * from UOA on every read; the only stored fact is which person stewards which
 * agent. That is what keeps this from becoming a second copy of the org
 * structure — see docs/plans/2026-08-29-people-and-their-agents.md.
 */

export type PeopleAgentsPerson = {
  member: WorkspaceMemberRecord
  agents: AgentRecord[]
}

export type PeopleAgentsTree = {
  people: PeopleAgentsPerson[]
  /** Agents nobody stewards — every pre-stewardship agent starts here. */
  unowned: AgentRecord[]
  /**
   * Owned, but by somebody this workspace's roster does not list. Deliberately
   * NOT labelled "departed": the roster is keyed by *team*, so an active
   * colleague in another team looks identical to someone UOA removed. Calling
   * both "left the company" would libel the former.
   */
  ownedOutsideWorkspace: AgentRecord[]
  /** System-managed agents (Personal Assistant, Librarian): nobody's staff. */
  system: AgentRecord[]
}

const isSystemAgent = (agent: AgentRecord): boolean =>
  agent.systemManaged === true || agent.agentKind === 'personal_assistant'

/**
 * Subtask children are run workers, not staff: `spawn_subtask` mints a
 * permanent Agent row per delegation and nothing reaps them, so listing them
 * under a person would bury their real agents under machine exhaust.
 */
const isSpawnedWorker = (agent: AgentRecord): boolean =>
  Boolean(agent.parentAgentId)

export const buildPeopleAgentsTree = (
  members: readonly WorkspaceMemberRecord[],
  agents: readonly AgentRecord[],
): PeopleAgentsTree => {
  const byOwner = new Map<string, AgentRecord[]>()
  const unowned: AgentRecord[] = []
  const system: AgentRecord[] = []

  for (const agent of agents) {
    if (isSpawnedWorker(agent)) continue
    if (isSystemAgent(agent)) {
      system.push(agent)
      continue
    }
    if (!agent.ownerUserId) {
      unowned.push(agent)
      continue
    }
    const existing = byOwner.get(agent.ownerUserId)
    if (existing) existing.push(agent)
    else byOwner.set(agent.ownerUserId, [agent])
  }

  const claimed = new Set<string>()
  const people = members.map((member) => {
    const owned = member.userId ? byOwner.get(member.userId) ?? [] : []
    if (member.userId && owned.length > 0) claimed.add(member.userId)
    return { agents: owned, member }
  })

  const ownedOutsideWorkspace = [...byOwner.entries()]
    .filter(([ownerUserId]) => !claimed.has(ownerUserId))
    .flatMap(([, ownerAgents]) => ownerAgents)

  return { ownedOutsideWorkspace, people, system, unowned }
}
