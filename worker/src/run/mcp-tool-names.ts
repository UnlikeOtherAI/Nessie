import { deepWaterManifestToolNames } from '@nessie/mcp-manage'

const EXPOSE_NAME_PREFIX = 'mcp_'

/**
 * The DeepWater tool names Nessie manages, derived from the manifest so a
 * contract change can never leave a stale list behind. `research_start` is no
 * longer projected, but stays managed while legacy launcher runs may still
 * dispatch it through a team that has not upgraded (Water plan amendments
 * N9.3); the retirement of the launcher handoff removes it.
 */
export const MANAGED_DEEP_WATER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...deepWaterManifestToolNames(),
  'research_start',
])

const sanitizeName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'tool'
}

const exposedNameFor = (toolName: string): string =>
  `${EXPOSE_NAME_PREFIX}${sanitizeName(toolName)}`

export const createMcpToolNameAllocator = (
  managedNames: ReadonlySet<string>,
): ((originalToolName: string, managed: boolean) => string) => {
  const managedExposedNames = new Set(
    [...managedNames].map(exposedNameFor),
  )
  const usedNames = new Set<string>()
  return (originalToolName, managed) => {
    let exposedName = exposedNameFor(originalToolName)
    if (!managed && managedExposedNames.has(exposedName)) {
      usedNames.add(exposedName)
    }
    let suffix = 2
    while (usedNames.has(exposedName)) {
      exposedName = `${exposedNameFor(originalToolName)}_${suffix}`
      suffix += 1
    }
    usedNames.add(exposedName)
    return exposedName
  }
}
