/**
 * src/agent/tools/policy.ts — Tool policy infrastructure for bundled tools.
 *
 * Implements server-verified group identity for tool policy filtering,
 * preventing callers from fabricating group IDs to widen tool access.
 *
 * Security invariant: Tool policy evaluation must use server-verified
 * identity signals only. Caller-provided groupId, senderId, or ownership
 * claims from the wire are untrusted input.
 */

import { fromOpenClawKey } from '../../openclaw/session-mapper.js'
import type { Tools } from '../../tools/types.js'
import { isToolAllowed } from '../../orchestration/role-registry.js'
import type { TaskRole } from '../../orchestration/task-types.js'

/**
 * Result of resolving a trusted group ID.
 * - groupId: the verified group ID, or null if none could be verified
 * - dropped: true if the caller-provided groupId was ignored/discarded
 */
export interface TrustedGroupIdResult {
  groupId: string | null
  dropped: boolean
}

/**
 * Trusted group IDs derived from server-side session context.
 */
export interface TrustedGroupIds {
  fromSessionKey: string | null
  fromSpawnedBy: string | null
}

/**
 * Parse a session key to extract the group ID.
 * Session key format: agent:<agentId>:<channel>:group:<groupId>
 *
 * Returns null if the key cannot be parsed or doesn't contain a group.
 */
export function resolveGroupContextFromSessionKey(sessionKey: string): string | null {
  const parsed = fromOpenClawKey(sessionKey)
  return parsed?.groupId ?? null
}

/**
 * Resolve a trusted group ID from caller-provided value + server-side signals.
 *
 * @param params.groupId - Caller-provided groupId (untrusted)
 * @param params.sessionKey - Server-side session key encoding the actual group
 * @param params.spawnedBy - Parent task ID (spawnedBy concept)
 *
 * Logic:
 * - Empty caller groupId → return as-is with dropped:false
 * - No trusted group context (neither sessionKey nor spawnedBy) → return null, dropped:true (fail closed)
 * - Caller groupId matches a trusted source → return caller value
 * - Caller groupId disagrees with trusted sources → return null, dropped:true + warn
 */
export function resolveTrustedGroupId(params: {
  groupId?: string | null
  sessionKey?: string
  spawnedBy?: string
}): TrustedGroupIdResult {
  const { groupId: callerGroupId, sessionKey, spawnedBy } = params

  // Trim and normalize caller groupId
  const trimmedCaller = (callerGroupId ?? '').trim()

  // If caller groupId is empty, return as-is without disagreement
  if (!trimmedCaller) {
    return { groupId: trimmedCaller || null, dropped: false }
  }

  // Collect trusted group IDs from server-side sources
  const trusted: TrustedGroupIds = {
    fromSessionKey: sessionKey ? resolveGroupContextFromSessionKey(sessionKey) : null,
    fromSpawnedBy: spawnedBy ?? null,
  }

  const trustedValues = [trusted.fromSessionKey, trusted.fromSpawnedBy].filter(
    (v): v is string => v !== null,
  )

  // If no trusted sources exist, fail closed — don't accept caller value
  if (trustedValues.length === 0) {
    console.warn(
      '[policy] No server-verified group context (sessionKey/spawnedBy). ' +
      `Rejecting caller groupId="${trimmedCaller}".`,
    )
    return { groupId: null, dropped: true }
  }

  // If caller value is in the trusted list, accept it
  if (trustedValues.includes(trimmedCaller)) {
    return { groupId: trimmedCaller, dropped: false }
  }

  // Disagreement: caller value doesn't match any trusted source → fail closed
  console.warn(
    `[policy] Caller groupId="${trimmedCaller}" does not match server-verified ` +
    `group context (sessionKey:${trusted.fromSessionKey ?? 'null'}, ` +
    `spawnedBy:${trusted.fromSpawnedBy ?? 'null'}). Rejected.`,
  )
  return { groupId: null, dropped: true }
}

/**
 * Policy context for filtering bundled tools.
 */
export interface ToolPolicyContext {
  /** Caller-provided groupId (untrusted until verified) */
  groupId?: string | null
  /** Server-side session key encoding the actual group */
  sessionKey?: string
  /** Parent task ID that spawned this context */
  spawnedBy?: string
  /** Role for role-based tool policy */
  role: TaskRole
  /** Agent ID this policy applies to */
  agentId?: string
}

/**
 * Result of applying tool policy to a tool list.
 */
export interface PolicyFilteredTools {
  /** Tools that passed policy filtering */
  tools: Tools
  /** Whether any tools were dropped due to policy */
  filtered: boolean
  /** Number of tools dropped */
  droppedCount: number
}

/**
 * Apply role-based tool policy filtering to a set of bundled tools,
 * using server-verified group identity.
 *
 * This ensures bundled tools (MCP/LSP tools) are subject to the same
 * policy pipeline as core tools, preventing policy bypass.
 *
 * @param bundledTools - The bundled tools to filter
 * @param context - Policy context including verified groupId
 */
export function applyFinalEffectiveToolPolicy(
  bundledTools: Tools,
  context: ToolPolicyContext,
): PolicyFilteredTools {
  const { groupId: _callerGroupId, sessionKey, spawnedBy, role } = context

  // Verify the caller-provided groupId against server-side sources
  const trusted = resolveTrustedGroupId({
    groupId: _callerGroupId,
    sessionKey,
    spawnedBy,
  })

  // Apply role-based tool policy to bundled tools
  // Note: In OpenClaw, there would be per-agent, per-group allowlists layered on top.
  // In Nessie, we apply role-based policy as the primary mechanism.
  const allowedToolNames = bundledTools
    .filter(tool => isToolAllowed(role, tool.name))
    .map(tool => tool.name)

  const droppedTools = bundledTools.filter(tool => !allowedToolNames.includes(tool.name))

  if (droppedTools.length > 0) {
    console.info(
      `[policy] Filtered ${droppedTools.length} bundled tool(s) for role="${role}" ` +
      `(groupId=${trusted.groupId ?? 'null'}, dropped=${trusted.dropped}): ` +
      droppedTools.map(t => t.name).join(', '),
    )
  }

  const filteredTools = bundledTools.filter(tool => allowedToolNames.includes(tool.name)) as Tools

  return {
    tools: filteredTools,
    filtered: droppedTools.length > 0 || trusted.dropped,
    droppedCount: droppedTools.length + (trusted.dropped ? 1 : 0),
  }
}

/**
 * Check if a specific tool is allowed for a given role.
 * Convenience function wrapping isToolAllowed from role-registry.
 */
export function isToolAllowedForRole(toolName: string, role: TaskRole): boolean {
  return isToolAllowed(role, toolName)
}

/**
 * Filter a tool list to only include tools allowed for the given role.
 */
export function filterToolsByRole(tools: Tools, role: TaskRole): Tools {
  return tools.filter(tool => isToolAllowed(role, tool.name)) as Tools
}
