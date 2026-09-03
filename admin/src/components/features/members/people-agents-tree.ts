import type { TeamMemberRecord } from '@nessie/schemas'
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
  member: TeamMemberRecord
  agents: AgentRecord[]
}

export type PeopleAgentsTree = {
  people: PeopleAgentsPerson[]
  /**
   * Agents nobody stewards. A deliberate state rather than only missing
   * history: a null owner is "team-owned", and every member entitled to such an
   * agent may edit it. Every pre-stewardship agent starts here.
   */
  teamOwned: AgentRecord[]
  /**
   * Owned, but by somebody this team's roster does not list. Deliberately
   * NOT labelled "departed": the roster is keyed by *team*, so an active
   * colleague in another team looks identical to someone UOA removed. Calling
   * both "left the company" would libel the former.
   */
  ownedOutsideTeam: AgentRecord[]
  /** System-managed agents (Personal Assistant, Librarian): nobody's staff. */
  system: AgentRecord[]
  /** Owner-only agents paused because their owner is inactive; names stay private. */
  pausedPrivateAgentCount: number
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
  members: readonly TeamMemberRecord[],
  agents: readonly AgentRecord[],
  input: { pausedPrivateAgentCount?: number } = {},
): PeopleAgentsTree => {
  const byOwner = new Map<string, AgentRecord[]>()
  const teamOwned: AgentRecord[] = []
  const system: AgentRecord[] = []

  for (const agent of agents) {
    if (isSpawnedWorker(agent)) continue
    if (isSystemAgent(agent)) {
      system.push(agent)
      continue
    }
    if (!agent.ownerUserId) {
      teamOwned.push(agent)
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

  const ownedOutsideTeam = [...byOwner.entries()]
    .filter(([ownerUserId]) => !claimed.has(ownerUserId))
    .flatMap(([, ownerAgents]) => ownerAgents)

  return {
    ownedOutsideTeam,
    pausedPrivateAgentCount: input.pausedPrivateAgentCount ?? 0,
    people,
    system,
    teamOwned,
  }
}
