const INSTANCE_PARAM = 'instance'

/**
 * "Show me the tools this connector projected" — the `?instance=<id>` filter
 * that narrows the owner review when an install has tools awaiting review.
 *
 * Deliberately separate from `deep-water-tool-filter.ts`: that one selects the
 * six-entry DeepWater *bundle* and therefore always includes the built-in
 * `deep_water_run_update` alongside the instance's own rows. This asks a
 * plainer question — which registry entries came from this MCP instance — and
 * folding the two together would make the bundle view leak a builtin into
 * every connector's list.
 */

export type McpInstanceToolFilter = string | null | undefined

export type McpInstanceToolFilterCandidate = {
  mcpInstanceId: string | null
}

export const readMcpInstanceToolFilter = (
  searchParams: Pick<URLSearchParams, 'get' | 'has'>,
): McpInstanceToolFilter => {
  if (!searchParams.has(INSTANCE_PARAM)) return undefined
  const instanceId = searchParams.get(INSTANCE_PARAM)?.trim()
  return instanceId || null
}

export const matchesMcpInstanceToolFilter = (
  tool: McpInstanceToolFilterCandidate,
  instanceId: McpInstanceToolFilter,
): boolean => {
  if (instanceId === undefined) return true
  return instanceId !== null && tool.mcpInstanceId === instanceId
}

export const mcpInstanceToolsPath = (instanceId: string): string =>
  `/agents/tools?status=pending_review&${INSTANCE_PARAM}=${encodeURIComponent(instanceId)}`
