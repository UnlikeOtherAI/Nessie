/**
 * Agent avatar generation moved to `@nessie/team-admin` so the assistant's
 * `agent_create` tool can run the same generate-then-attach step the create
 * route runs — `api/src/services/*` is unreachable from the worker, and a
 * second copy would fork the one billed Ledger image path on day one.
 *
 * Established API callers keep importing it from here.
 */
export {
  AgentAvatarGenerationError,
  generateAgentAvatar,
  generateAvatarForNewAgent,
  type GeneratedAgentAvatar,
} from '@nessie/team-admin'
