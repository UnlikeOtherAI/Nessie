import type { AgentRecord } from '../../lib/api-client'

/**
 * The fields an agent's picture is drawn from. A partial shape on purpose:
 * several surfaces (the PA presence payload, the sidebar's DM projection) carry
 * only an id and a label, and hand what they have to `AgentAvatar`, which then
 * upgrades it through the agent identity directory.
 */
export type AgentIdentity = Pick<AgentRecord, 'id' | 'name' | 'role'> &
  Partial<Pick<AgentRecord, 'avatarAttachmentId' | 'avatarBackgroundColor'>>

/**
 * The emoji shown for an agent that has no portrait yet. It is a last resort,
 * not an identity: an agent whose picture is merely unresolved must reach the
 * directory before landing here, or every unknown agent becomes the same bolt.
 */
export const getAgentGlyph = (agent?: Pick<AgentIdentity, 'role'> | null): string => {
  if (!agent?.role) {
    return '⚡'
  }

  const role = agent.role.toLowerCase()
  if (role.includes('research')) {
    return '🔍'
  }
  if (role.includes('write')) {
    return '📝'
  }
  return '⚡'
}
