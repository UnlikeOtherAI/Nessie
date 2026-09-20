// API compatibility entry point; the worker and REST controls share this exact
// descriptor-bound policy mutation implementation.
export {
  backfillProtectedMcpToolGrants,
  setAgentToolPolicyForRegistryEntry,
} from '@nessie/mcp-manage'
