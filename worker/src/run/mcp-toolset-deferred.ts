import type { ToolSchemaDescriptor } from '@nessie/runtime'

import { truncate } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'
import type { McpToolEntry } from './mcp-toolset.js'

/**
 * Deferred MCP tool presentation (spec: `docs/external-tool-integration.md`
 * §5 "Temporary Context and Tool Resolution").
 *
 * Inlining every connector tool's full JSON schema pollutes the model's
 * context: 50 tools × ~200 tokens is thousands of tokens the agent never
 * uses. Above `DEFAULT_INLINE_TOOL_LIMIT` exposed tools, the toolset switches
 * to a three-step flow occupying three small schemas instead:
 *
 *   1. `mcp_find_tools`   — search the connector tool directory (ranked,
 *                            compact results with a parameter summary);
 *   2. `mcp_load_tools`   — load selected tools' full schemas into the live
 *                            tool list (bounded; oldest loaded are evicted);
 *   3. call the tool directly — loaded tools are ordinary tool calls; when
 *      done, `mcp_drop_tools` frees the context again.
 *
 * Each consumer (main agent loop, delegate sub-agent) gets its OWN view, so a
 * sub-agent loading schemas never mutates the parent's context. The
 * `descriptors` array is live: the loop recomposes its tool list from it on
 * every inference call, which is what makes load/drop take effect mid-run.
 */

export const DEFAULT_INLINE_TOOL_LIMIT = 12
export const MAX_LOADED_TOOLS = 15

export type McpToolsetView = {
  /** LIVE array — recompose the model's tool list from it each inference. */
  descriptors: ToolSchemaDescriptor[]
  /** Every name this view's dispatch accepts (meta tools + all MCP tools). */
  handledNames: Set<string>
  dispatch: (
    exposedName: string,
    args: Record<string, unknown>,
  ) => Promise<AgenticToolResult>
}

const summarizeParams = (inputSchema: Record<string, unknown>): string => {
  const properties = inputSchema['properties']
  if (!properties || typeof properties !== 'object') return ''
  const required = new Set(
    Array.isArray(inputSchema['required']) ? (inputSchema['required'] as string[]) : [],
  )
  const names = Object.keys(properties as Record<string, unknown>).map((name) =>
    required.has(name) ? `${name}*` : name,
  )
  return names.length > 0 ? ` (params: ${names.slice(0, 8).join(', ')})` : ''
}

/** Compact per-connector directory for the find tool's description. */
const buildDirectory = (entries: McpToolEntry[]): string => {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.connectorLabel, (counts.get(entry.connectorLabel) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([label, count]) => `${label} (${count})`)
  return truncate(parts.join(', '), 500)
}

const scoreEntry = (entry: McpToolEntry, tokens: string[]): number => {
  const name = entry.originalToolName.toLowerCase()
  const label = entry.connectorLabel.toLowerCase()
  const description = entry.description.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (name.includes(token)) score += 3
    if (label.includes(token)) score += 2
    if (description.includes(token)) score += 1
  }
  return score
}

const formatMatch = (entry: McpToolEntry): string =>
  `- ${entry.exposedName}${summarizeParams(entry.inputSchema)} [${entry.connectorLabel}]\n`
  + `  ${truncate(entry.description || entry.originalToolName, 140)}`

export const buildDeferredView = (
  entries: McpToolEntry[],
  baseDispatch: McpToolsetView['dispatch'],
): McpToolsetView => {
  const byExposedName = new Map(entries.map((entry) => [entry.exposedName, entry]))
  const directory = buildDirectory(entries)

  const metaDescriptors: ToolSchemaDescriptor[] = [
    {
      toolName: 'mcp_find_tools',
      description:
        `Search the ${entries.length} connector tools available to you. `
        + `Connected services: ${directory}. `
        + 'Returns matching tool names with a parameter summary. Load the '
        + 'ones you need with mcp_load_tools, then call them directly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you want to do (e.g. "create notion page")',
          },
        },
        required: ['query'],
      },
    },
    {
      toolName: 'mcp_load_tools',
      description:
        'Load the full schemas of connector tools (by exact name from '
        + 'mcp_find_tools) into your tool list so you can call them directly '
        + `on your next step. At most ${MAX_LOADED_TOOLS} stay loaded — the `
        + 'oldest are dropped first. Drop tools you are done with via '
        + 'mcp_drop_tools.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact tool names to load',
          },
        },
        required: ['names'],
      },
    },
    {
      toolName: 'mcp_drop_tools',
      description:
        'Remove previously loaded connector tool schemas from your tool list '
        + '(all of them when names is omitted). Frees context space.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names to drop; omit to drop all loaded tools',
          },
        },
      },
    },
  ]

  // Live array: metas stay at the front, loaded schemas append after them.
  const descriptors: ToolSchemaDescriptor[] = [...metaDescriptors]
  const loadedOrder: string[] = []

  const removeLoaded = (name: string): void => {
    const index = loadedOrder.indexOf(name)
    if (index >= 0) loadedOrder.splice(index, 1)
    const descriptorIndex = descriptors.findIndex((d) => d.toolName === name)
    if (descriptorIndex >= metaDescriptors.length) {
      descriptors.splice(descriptorIndex, 1)
    }
  }

  const handledNames = new Set<string>([
    ...metaDescriptors.map((d) => d.toolName),
    ...entries.map((entry) => entry.exposedName),
  ])

  const findTools = (query: string): string => {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1)
    const ranked = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10)
    if (ranked.length === 0) {
      return (
        `No connector tools matched "${query}". Connected services: ${directory}. `
        + 'Try different words (tool names are usually verb_noun, e.g. '
        + '"create_page", "list_charges").'
      )
    }
    return [
      `Top matches (${ranked.length}):`,
      ...ranked.map((item) => formatMatch(item.entry)),
      '',
      'Load what you need: mcp_load_tools {"names": ["…"]} — then call the tool directly.',
    ].join('\n')
  }

  const loadTools = (names: string[]): string => {
    const loaded: string[] = []
    const unknown: string[] = []
    for (const rawName of names) {
      const name = rawName.trim()
      const entry = byExposedName.get(name)
      if (!entry) {
        unknown.push(name)
        continue
      }
      removeLoaded(name)
      descriptors.push({
        toolName: entry.exposedName,
        description: entry.description || `MCP tool ${entry.originalToolName}`,
        inputSchema: entry.inputSchema,
      })
      loadedOrder.push(name)
      loaded.push(name)
    }
    while (loadedOrder.length > MAX_LOADED_TOOLS) {
      removeLoaded(loadedOrder[0] as string)
    }
    const parts: string[] = []
    if (loaded.length > 0) {
      parts.push(
        `Loaded ${loaded.length} tool(s): ${loaded.join(', ')}. `
        + 'They are available as ordinary tools on your next step.',
      )
    }
    if (unknown.length > 0) {
      parts.push(
        `Unknown tool name(s): ${unknown.join(', ')} — use mcp_find_tools to get exact names.`,
      )
    }
    return parts.join('\n') || 'Nothing to load.'
  }

  const dropTools = (names?: string[]): string => {
    const targets = names && names.length > 0 ? names : [...loadedOrder]
    for (const name of targets) removeLoaded(name)
    return targets.length > 0
      ? `Dropped ${targets.length} tool schema(s).`
      : 'No loaded tools to drop.'
  }

  const dispatch: McpToolsetView['dispatch'] = async (exposedName, args) => {
    if (exposedName === 'mcp_find_tools') {
      const query = String(args['query'] ?? '')
      return { inputSummary: `query="${truncate(query, 80)}"`, output: findTools(query), success: true }
    }
    if (exposedName === 'mcp_load_tools') {
      const names = Array.isArray(args['names']) ? args['names'].map(String) : []
      return { inputSummary: `names=${names.length}`, output: loadTools(names), success: true }
    }
    if (exposedName === 'mcp_drop_tools') {
      const names = Array.isArray(args['names']) ? args['names'].map(String) : undefined
      return { inputSummary: `names=${names?.length ?? 'all'}`, output: dropTools(names), success: true }
    }
    // Real tools dispatch whether or not their schema is currently loaded —
    // a model that remembers a name from mcp_find_tools shouldn't be blocked.
    return baseDispatch(exposedName, args)
  }

  return { descriptors, handledNames, dispatch }
}

/** Inline mode: every schema visible, no meta tools — small setups keep the best UX. */
export const buildInlineView = (
  entries: McpToolEntry[],
  baseDispatch: McpToolsetView['dispatch'],
): McpToolsetView => ({
  descriptors: entries.map((entry) => ({
    toolName: entry.exposedName,
    description: entry.description || `MCP tool ${entry.originalToolName}`,
    inputSchema: entry.inputSchema,
  })),
  handledNames: new Set(entries.map((entry) => entry.exposedName)),
  dispatch: baseDispatch,
})
