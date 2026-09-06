const DEEP_WATER_INSTANCE_PARAM = 'deepWaterInstance'
const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const DEEP_WATER_RUN_UPDATE_TOOL_ID = 'deep_water_run_update'

export type DeepWaterInstanceFilter = string | null | undefined

export type DeepWaterToolFilterCandidate = {
  builtin: boolean
  managedProductSlug: string | null
  mcpInstanceId: string | null
  toolId: string
}

export const readDeepWaterInstanceFilter = (
  searchParams: Pick<URLSearchParams, 'get' | 'has'>,
): DeepWaterInstanceFilter => {
  if (!searchParams.has(DEEP_WATER_INSTANCE_PARAM)) return undefined
  const instanceId = searchParams.get(DEEP_WATER_INSTANCE_PARAM)?.trim()
  return instanceId || null
}

export const matchesDeepWaterInstanceFilter = (
  tool: DeepWaterToolFilterCandidate,
  instanceId: DeepWaterInstanceFilter,
): boolean => {
  if (instanceId === undefined) return true
  if (tool.builtin && tool.toolId === DEEP_WATER_RUN_UPDATE_TOOL_ID) return true
  return (
    instanceId !== null
    && tool.managedProductSlug === DEEP_WATER_PRODUCT_SLUG
    && tool.mcpInstanceId === instanceId
  )
}
