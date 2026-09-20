/**
 * Agent deletion is shared with identity-delegated Designer tools.
 * Keep this forwarding module so API callers retain their stable import path.
 */
export { deleteAgent, type DeleteAgentResult } from '@nessie/team-admin'
