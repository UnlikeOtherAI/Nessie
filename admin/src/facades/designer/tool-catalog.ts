import { useMemo } from 'react'
import { TOOL_CATEGORIES, findToolCategory } from '@nessie/schemas'
import { useMcpToolRegistry } from '../tool-grants/hooks'
import { useTools } from '../tools/hooks'

/**
 * Unified tool catalog for the agent designer and agent detail surfaces.
 *
 * The worker resolves an agent's tools from `Agent.toolPolicy` with two
 * different key spaces (see `worker/src/run/tool-policy.ts` and
 * `worker/src/run/mcp-toolset.ts`):
 *   - builtin tools are keyed by their tool id (e.g. `web_search`) and are
 *     allowed unless the policy sets them to `false`;
 *   - MCP/connector tools are keyed by their registry entry uuid and are
 *     denied unless the policy sets them to `true`.
 *
 * The exception is a builtin flagged `requiresExplicitGrant` (e.g.
 * `deep_water_run_update`): like a connector it is OFF by default and needs an
 * explicit `true` in the policy — so it uses the connector (allow-mode) policy
 * shape even though it is a builtin.
 *
 * This hook merges the builtin descriptor feed (`/api/tools`, any actor) with
 * the connector registry (`/api/mcp/tools`, owner only) into one option list
 * carrying the correct policy key and default per tool.
 */

export type DesignerToolOption = {
  /** Key to read/write in `Agent.toolPolicy`. */
  key: string
  label: string
  description: string
  kind: 'builtin' | 'mcp'
  /** Effective state when the agent's policy does not mention the key. */
  defaultEnabled: boolean
  /**
   * When true the policy records an explicit allow (`true`) to enable and omits
   * the key to disable — the connector/allow-mode shape. Connector tools and
   * explicit-grant builtins use this; ordinary builtins use deny-mode.
   */
  allowMode: boolean
  /** Display name of the section this tool renders under. */
  group: string
}

export type DesignerToolGroup = {
  /** One line on what belongs here, so a closed section still explains itself. */
  description?: string
  name: string
  tools: DesignerToolOption[]
}

/**
 * Groups are what the tools declare, not what their ids look like.
 *
 * This used to be a list of id-prefix rules (`file_`, `web_`, `kb_`…) with an
 * "Agent & workspace" fallback, and that fallback had grown to hold 75 of 116
 * builtins — a new tool joined it by default and only a new prefix rule got it
 * out. `BuiltinToolDefinition.category` is now required, so the catalogue
 * renders a decision its author made rather than guessing one here.
 *
 * `Connectors (MCP)` and `Other` are the two categories this layer still
 * decides, because neither is a builtin: a connector tool's home is the
 * connector, and an organization-local registry entry genuinely has no
 * declared category. No builtin can reach `Other`.
 */
const CONNECTOR_GROUP = 'Connectors (MCP)'
const UNCATEGORISED_GROUP = 'Other'

const GROUP_ORDER: ReadonlyArray<{ description?: string; name: string }> = [
  ...TOOL_CATEGORIES.map((category) => ({
    description: category.description,
    name: category.label,
  })),
  {
    description: 'Tools projected from the apps this organisation has installed.',
    name: CONNECTOR_GROUP,
  },
  {
    description: 'Registered for this organisation without a declared category.',
    name: UNCATEGORISED_GROUP,
  },
]

const groupForBuiltin = (category: string | undefined): string =>
  (category ? findToolCategory(category)?.label : undefined) ?? UNCATEGORISED_GROUP

export const useDesignerToolCatalog = (includeConnectors: boolean) => {
  const builtinQuery = useTools()
  const registryQuery = useMcpToolRegistry({}, includeConnectors)

  const options = useMemo<DesignerToolOption[]>(() => {
    const builtin: DesignerToolOption[] = (builtinQuery.data ?? [])
      .filter(
        (tool) =>
          tool.builtin !== false
          && tool.enabled !== false
          && tool.requiresExplicitGrant !== true,
      )
      .map((tool) => ({
        key: tool.id,
        label: tool.label,
        description: tool.description,
        kind: 'builtin' as const,
        // Explicit-grant builtins are off by default and grant via an explicit
        // allow, exactly like connectors.
        defaultEnabled: !tool.requiresExplicitGrant,
        allowMode: tool.requiresExplicitGrant === true,
        group: groupForBuiltin(tool.category),
      }))

    const connectors: DesignerToolOption[] = (
      includeConnectors ? registryQuery.data ?? [] : []
    )
      .filter(
        (tool) =>
          !tool.builtin
          && tool.enabled
          && tool.status === 'active'
          && !tool.requiresExplicitGrant,
      )
      .map((tool) => ({
        key: tool.id,
        label: tool.label,
        description: tool.description,
        kind: 'mcp' as const,
        defaultEnabled: false,
        allowMode: true,
        group: CONNECTOR_GROUP,
      }))

    return [...builtin, ...connectors]
  }, [builtinQuery.data, includeConnectors, registryQuery.data])

  const groups = useMemo<DesignerToolGroup[]>(() => {
    const byName = new Map<string, DesignerToolOption[]>()
    for (const option of options) {
      const bucket = byName.get(option.group) ?? []
      bucket.push(option)
      byName.set(option.group, bucket)
    }

    return GROUP_ORDER.flatMap((group) => {
      const tools = byName.get(group.name)
      if (!tools || tools.length === 0) return []
      return [{
        description: group.description,
        name: group.name,
        tools: [...tools].sort((a, b) => a.label.localeCompare(b.label)),
      }]
    })
  }, [options])

  return {
    groups,
    isError: builtinQuery.isError || (includeConnectors && registryQuery.isError),
    isLoading: builtinQuery.isLoading || (includeConnectors && registryQuery.isLoading),
    options,
    refetch: () => {
      void builtinQuery.refetch()
      if (includeConnectors) void registryQuery.refetch()
    },
  }
}

/** The three states {@link QueryState} needs, satisfied structurally by the
 * object above — a caller can pass it straight through as `query`. */
export type DesignerToolCatalogQuery = {
  isError: boolean
  isLoading: boolean
  refetch: () => unknown
}

/**
 * Resolve the effective enabled state for a tool given a (possibly sparse)
 * policy record: explicit entry wins, otherwise the kind's default applies.
 */
export const isToolEnabled = (
  tool: DesignerToolOption,
  policy: Record<string, boolean>,
): boolean => policy[tool.key] ?? tool.defaultEnabled

/**
 * Build the sparse `toolPolicy` payload the worker expects. Allow-mode tools
 * (connectors + explicit-grant builtins) are recorded only when enabled (as an
 * explicit `true`); ordinary deny-mode builtins are recorded only when disabled
 * (as an explicit `false`).
 */
export const buildToolPolicy = (
  options: DesignerToolOption[],
  toolState: Record<string, boolean>,
): Record<string, boolean> => {
  const policy: Record<string, boolean> = {}
  for (const tool of options) {
    const enabled = toolState[tool.key] ?? tool.defaultEnabled
    if (tool.allowMode) {
      if (enabled) policy[tool.key] = true
    } else if (!enabled) {
      policy[tool.key] = false
    }
  }
  return policy
}
