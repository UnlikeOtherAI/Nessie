/**
 * Agent avatar writes moved to `@nessie/team-admin` alongside the rest of
 * the actor-gated agent edit path: the Agent Designer's `agent_avatar_update`
 * tool runs the same function this route's button runs, and the worker cannot
 * import `api/src/services/*`.
 */
export { updateAgentAvatar } from '@nessie/team-admin'
