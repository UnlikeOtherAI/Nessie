import type { ExecutorLocalMcpReport } from '@nessie/schemas'

/**
 * What the daemon last observed about its named MCP servers, in the few lines
 * a model-facing answer can carry.
 *
 * Three states must survive the summary because they lead to different
 * actions: never reported at all, reported-and-named-nothing, and named but
 * unavailable with the reason why. The instance list is Kelpie's, and it is
 * stated as last-observed with its own age — a caller that reads it as live
 * will send somebody to a browser that has moved or gone.
 *
 * It lives in this package rather than in the Personal Assistant's tool file
 * because two readers now need exactly this rendering and exactly these three
 * states: `executor_inspect`'s answer, and the Agent Designer's generated
 * design catalogue. A second copy is how "absent is not empty" gets flattened
 * in one of them without a failing test anywhere.
 */
export const formatExecutorLocalMcp = (
  localMcp: ExecutorLocalMcpReport | undefined,
  observedAt: string | undefined,
): string => {
  if (localMcp === undefined) {
    return ['Local MCP servers', '- this executor has never reported its local MCP status'].join('\n')
  }
  if (localMcp.length === 0) {
    return ['Local MCP servers', '- reported, and names no local MCP server'].join('\n')
  }
  const age = observedAt ? ` (observed ${observedAt})` : ''
  return [`Local MCP servers${age}`, ...localMcp.flatMap((status) => {
    const head = status.available
      ? `- ${status.server}=available${
        status.serverVersion ? ` version=${status.serverVersion}` : ''
      }${status.toolCount === undefined ? '' : ` tools=${status.toolCount}`}`
      : `- ${status.server}=unavailable reason=${status.reason ?? 'unstated'}`
    if (status.kelpieDevices === undefined) return [head]
    if (status.kelpieDevices.length === 0) {
      return [head, '  instances: none announced on that network']
    }
    return [
      head,
      // Bounded: a model-facing answer is read, not scrolled, and the wire
      // contract already allows up to 32.
      ...status.kelpieDevices.slice(0, 8).map((device) => (
        `  - ${device.name}${device.model ? ` (${device.model})` : ''} ${device.platform}`
        + `${device.version ? ` v${device.version}` : ''} at ${device.address}:${device.port}`
        + ` ${device.paired ? 'paired' : 'NOT paired — a person must pair on the device'}`
        + ` last seen ${device.lastSeenAt}`
      )),
      ...(status.kelpieDevices.length > 8
        ? [`  - …and ${status.kelpieDevices.length - 8} more`]
        : []),
    ]
  })].join('\n')
}
