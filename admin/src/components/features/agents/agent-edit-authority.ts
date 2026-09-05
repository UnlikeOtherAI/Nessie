import type { AgentRecord } from '../../../lib/api-client'
import { isOwnerSession } from '../../../facades/auth/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

/**
 * Who may edit this agent — the client half of the server's `canEditAgent`.
 *
 * The server rule (`@nessie/team-admin` `agent-edit-authority.ts`) is the
 * boundary; this decides which affordances to paint, and must say the same
 * thing or a person gets a button that 403s. It can, because every fact it
 * needs is on the record: ownership state, visibility, and system management.
 *
 * The entitlement arm needs no request of its own. `GET /api/agents` is already
 * scoped to what this viewer may see, so an agent that reached this component
 * *is* one they are entitled to — which is exactly the team-owned condition.
 */

export type AgentOwnershipState = 'private' | 'person_owned' | 'team_owned' | 'system'

export const agentOwnershipState = (agent: AgentRecord): AgentOwnershipState => {
  if (agent.systemManaged === true || agent.agentKind === 'personal_assistant') return 'system'
  if (agent.visibility === 'private') return 'private'
  return agent.ownerUserId ? 'person_owned' : 'team_owned'
}

export type AgentEditViewer = {
  isOrgOwner: boolean
  userId: string | null
}

export const canEditAgentRecord = (
  agent: AgentRecord,
  viewer: AgentEditViewer,
): boolean => {
  switch (agentOwnershipState(agent)) {
    // A blueprint-managed agent is nobody's to edit, organization owners
    // included: its configuration ships with the deployment.
    case 'system':
      return false
    // Private beats owner omniscience — an organization owner cannot even see
    // this agent, so there is nothing here for them to change.
    case 'private':
      return Boolean(viewer.userId) && agent.ownerUserId === viewer.userId
    case 'person_owned':
      return viewer.isOrgOwner || (Boolean(viewer.userId) && agent.ownerUserId === viewer.userId)
    // Team-owned: any entitled member. Seeing it here is the entitlement.
    case 'team_owned':
      return true
  }
}

/**
 * Ownership transitions are narrower than editing: transfer, and release to the
 * team, belong to the current owner or an organization owner. Claiming a
 * team-owned agent is therefore organization-owner-only by construction, since
 * a team-owned agent has no current owner to be.
 */
export const canChangeAgentOwner = (
  agent: AgentRecord,
  viewer: AgentEditViewer,
): boolean => {
  const state = agentOwnershipState(agent)
  // A private agent's owner is encoded in its owner-only home DM, so v1 asks
  // the person to publish before transferring rather than orphaning that home.
  if (state === 'system' || state === 'private') return false
  return viewer.isOrgOwner || (Boolean(viewer.userId) && agent.ownerUserId === viewer.userId)
}

export const useAgentEditViewer = (): AgentEditViewer => {
  const { me } = useAuthSession()
  return { isOrgOwner: isOwnerSession(me), userId: me?.user.id ?? null }
}

export const useCanEditAgent = (agent: AgentRecord | null | undefined): boolean => {
  const viewer = useAgentEditViewer()
  return agent ? canEditAgentRecord(agent, viewer) : false
}
