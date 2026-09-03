import {
  applyMcpRequestIdentity,
  callInstanceTool,
  mcpTransportAudience,
} from '@nessie/mcp-manage'
import type {
  DeepSignalMcpIdentityService,
  LedgerAttribution,
} from '@nessie/runtime'
import type { McpTransportConfig } from '@nessie/schemas'

export type DeepSignalMcpCallContext = {
  attribution: LedgerAttribution
  identityService: DeepSignalMcpIdentityService
  callTool?: typeof callInstanceTool
}

const toolCallId = (
  attribution: LedgerAttribution,
  toolName: string,
): string => {
  const requestId = attribution.requestId?.trim()
  if (!requestId) {
    throw new Error('DeepSignal MCP calls require request provenance.')
  }
  return `${requestId}:${toolName}`
}

/**
 * Call one DeepSignal tool through the shared one-shot MCP dispatcher. The
 * stored transport already carries Nessie's DeepSignal-issued app key; this
 * adds fresh, independently signed UOA actor/team and Nessie provenance
 * headers without allowing either to replace Authorization.
 */
export const callDeepSignalMcpTool = async (
  transport: McpTransportConfig,
  ctx: DeepSignalMcpCallContext,
  toolName: string,
  args: unknown,
) => {
  const headers = await ctx.identityService.requestHeaders(ctx.attribution, {
    audience: mcpTransportAudience(transport),
    toolCallId: toolCallId(ctx.attribution, toolName),
  })
  return (ctx.callTool ?? callInstanceTool)({
    transport: applyMcpRequestIdentity(transport, headers),
    toolName,
    args,
  })
}
