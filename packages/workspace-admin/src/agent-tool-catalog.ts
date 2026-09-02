import type { Prisma, PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { findToolCategory } from '@nessie/schemas'

import {
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
} from './agent-tool-policy-core.js'

/**
 * The tool catalogue a designed agent can be given, for a member.
 *
 * `GET /api/mcp/tools` is organization-owner-only and must stay that way — it
 * carries transport config, grants and review state. This is the member-safe
 * projection of the same two sources the Agent Designer page merges
 * (`admin/src/facades/designer/tool-catalog.ts`): the builtin definitions in
 * deny-mode, and the organization's live, active connector rows in allow-mode
 * keyed by registry uuid.
 *
 * Leak-proof by construction, the `/api/apps` presenter discipline: an entry is
 * assembled field-by-field from a narrow selection, so there is no shape in
 * which a `credentialRef`, an endpoint URL, an auth block, a transport config or
 * a grant row can be emitted. `metadata` is read only to decide one boolean and
 * is never carried into an entry.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D4, D5).
 */

/** Why a tool cannot simply be switched on for a designed agent. */
export type AgentToolRestriction =
  /** `personalAssistantOnly` — the person's own delegate wields these, never a designed agent. */
  | 'personal_assistant_only'
  /** `requiresExplicitGrant` — granted from an owner surface, never from a design conversation. */
  | 'explicit_grant'

export type AgentToolCatalogEntry = {
  /**
   * When to write the key: allow-mode records an explicit `true` to enable and
   * omits the key to disable; deny-mode records an explicit `false` to disable.
   */
  allowMode: boolean
  /** The effective state when an agent's policy does not mention the key. */
  defaultEnabled: boolean
  group: string
  /** The key to read and write in `Agent.toolPolicy`. */
  key: string
  kind: 'builtin' | 'connector'
  label: string
  /** True only while the agent's `todosEnabled` is on. */
  requiresTodos?: boolean
  summary: string
}

export type AgentToolCatalogRestrictedEntry = AgentToolCatalogEntry & {
  restriction: AgentToolRestriction
}

export type AgentToolCatalog = {
  /** Connector rows exist for this organization but none are active. */
  connectorCount: number
  /** Tools a designed agent's `toolPolicy` may switch on or off. */
  togglable: AgentToolCatalogEntry[]
  /** Tools that exist but are not the Designer's to grant — named, with why. */
  restricted: AgentToolCatalogRestrictedEntry[]
}

const CONNECTOR_GROUP = 'Connectors (MCP)'
const UNCATEGORISED_GROUP = 'Other'

/** Builtins whose availability additionally depends on `Agent.todosEnabled`. */
const TODO_GATED_TOOL_IDS = new Set([
  'todo_start',
  'todo_step_update',
  'todo_template_propose',
])

const groupForBuiltin = (category: string | undefined): string =>
  (category ? findToolCategory(category)?.label : undefined) ?? UNCATEGORISED_GROUP

const byLabel = (
  a: AgentToolCatalogEntry,
  b: AgentToolCatalogEntry,
): number => a.label.localeCompare(b.label)

/**
 * The narrow selection. Everything a catalogue entry can possibly contain is on
 * this list, so widening the projection means widening this first.
 */
const CONNECTOR_ENTRY_SELECT = {
  description: true,
  handlerKind: true,
  id: true,
  label: true,
  metadata: true,
  toolId: true,
} satisfies Prisma.ToolRegistryEntrySelect

type ConnectorEntryRow = Prisma.ToolRegistryEntryGetPayload<{
  select: typeof CONNECTOR_ENTRY_SELECT
}>

const summarise = (value: string): string => {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > 240 ? `${text.slice(0, 237)}…` : text
}

const toConnectorEntry = (row: ConnectorEntryRow): AgentToolCatalogEntry => ({
  allowMode: true,
  defaultEnabled: false,
  group: CONNECTOR_GROUP,
  key: registryEntryPolicyKey(row),
  kind: 'connector',
  label: row.label,
  summary: summarise(row.description),
})

export const loadAgentToolCatalog = async (
  prisma: PrismaClient,
  input: { organizationId: string },
): Promise<AgentToolCatalog> => {
  // Builtin rows exist per organization and can be switched off for the whole
  // tenant; a tool nobody has seeded yet is still available, which is what the
  // worker's own seed-then-read does at run setup.
  const [builtinRows, connectorRows] = await Promise.all([
    prisma.toolRegistryEntry.findMany({
      where: { builtin: true, organizationId: input.organizationId },
      select: { enabled: true, toolId: true },
    }),
    prisma.toolRegistryEntry.findMany({
      where: {
        enabled: true,
        handlerKind: { not: 'builtin' },
        organizationId: input.organizationId,
        status: 'active',
      },
      select: CONNECTOR_ENTRY_SELECT,
      orderBy: { label: 'asc' },
    }),
  ])

  const disabledBuiltinIds = new Set(
    builtinRows.filter((row) => !row.enabled).map((row) => row.toolId),
  )

  const togglable: AgentToolCatalogEntry[] = []
  const restricted: AgentToolCatalogRestrictedEntry[] = []

  for (const tool of BUILTIN_TOOL_DEFINITIONS) {
    if (disabledBuiltinIds.has(tool.id)) continue
    const entry: AgentToolCatalogEntry = {
      allowMode: tool.requiresExplicitGrant === true,
      defaultEnabled: tool.requiresExplicitGrant !== true,
      group: groupForBuiltin(tool.category),
      key: tool.id,
      kind: 'builtin',
      label: tool.label,
      ...(TODO_GATED_TOOL_IDS.has(tool.id) ? { requiresTodos: true } : {}),
      summary: summarise(tool.summary),
    }
    if (tool.personalAssistantOnly) {
      restricted.push({ ...entry, restriction: 'personal_assistant_only' })
      continue
    }
    if (tool.requiresExplicitGrant) {
      restricted.push({ ...entry, restriction: 'explicit_grant' })
      continue
    }
    togglable.push(entry)
  }

  for (const row of connectorRows) {
    const entry = toConnectorEntry(row)
    if (registryEntryRequiresExplicitPolicy(row)) {
      restricted.push({ ...entry, restriction: 'explicit_grant' })
      continue
    }
    togglable.push(entry)
  }

  return {
    connectorCount: connectorRows.length,
    restricted: restricted.sort(byLabel),
    togglable: togglable.sort(byLabel),
  }
}
