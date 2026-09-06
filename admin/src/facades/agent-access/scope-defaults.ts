import type { AgentAccessScope } from './hooks'

/**
 * Scopes that are never pre-ticked, however confidently the agent asked.
 *
 * Most scopes default to what was requested, because granting *less* is the
 * deliberate act. Publishing inverts that: "agents draft; only a human may
 * publish" is a rule this product enforces elsewhere by refusing an agent
 * actor outright, and an MCP credential resolves as the human who approved it
 * — so the rule survives only if granting it is a tick somebody chose to make.
 */
export const OPT_IN_SCOPES: ReadonlySet<AgentAccessScope> = new Set([
  'documents_publish',
])

/** What the approval screen starts with ticked, given what was asked for. */
export const defaultGrantedScopes = (
  requested: readonly AgentAccessScope[],
): AgentAccessScope[] => requested.filter((scope) => !OPT_IN_SCOPES.has(scope))
