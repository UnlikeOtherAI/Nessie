/**
 * The local MCP servers a policy fronts, by name.
 *
 * It sits beside {@link ExecutorPermittedPrograms} and
 * {@link ExecutorReachableFolders} for the same reason they exist: naming a
 * server changes `localPolicyDigest`, so it is a revision somebody approves,
 * and approving a digest you cannot read is not a review. Two states, and
 * they must not render alike:
 *
 * - names listed — the reviewer approves proxying onto exactly those servers;
 * - no field at all — the policy fronts no local MCP server, so `mcp.tools`
 *   and `mcp.call` refuse. That is not "any server", and when the revision
 *   enables those operations the sentence has to say so rather than leave a
 *   blank line.
 *
 * An empty list cannot arrive: the descriptor contract carries the field only
 * when it names a server. How the daemon starts each server — argv, cwd, env —
 * never leaves the host, so there is deliberately nothing more to show.
 */
export type ExecutorMcpServersProps = {
  mcpServers?: readonly string[]
  operationKeys: readonly string[]
}

const MCP_OPERATION_KEYS = ['mcp.tools', 'mcp.call']

export const ExecutorMcpServers = ({
  mcpServers,
  operationKeys,
}: ExecutorMcpServersProps) => {
  const proxiesMcp = MCP_OPERATION_KEYS.some((operationKey) => operationKeys.includes(operationKey))
  // Nothing to say: this proposal offers no MCP proxying and named no server,
  // so there is no approval decision the list would inform.
  if (!mcpServers && !proxiesMcp) return null
  return mcpServers
    ? (
      <p className="mt-1 text-[color:var(--tx2)]">
        <span className="font-medium text-[color:var(--tx)]">
          Local apps ({mcpServers.length}):
        </span>{' '}
        {mcpServers.join(', ')}
        {proxiesMcp ? null : ' (using their tools is not enabled)'}
      </p>
    )
    : (
      <p className="mt-1 text-[color:var(--warning-text)]">
        <span className="font-medium">Local apps: none selected.</span>{' '}
        Choose an app on the computer before an agent can use its tools.
      </p>
    )
}
