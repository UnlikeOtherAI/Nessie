import type { ZodTypeAny } from 'zod'

export type BuiltinToolDefinition = {
  id: string
  summary: string
  description: string
  label: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  safe: boolean
  /**
   * When true, only the personal assistant (`agentKind = 'personal_assistant'`)
   * may call this tool. These are the "act as the user" tools — they write or
   * search using the acting user's own identity/authority (e.g. sending a
   * message as the user, joining the user to a channel, reading the user's
   * authored messages, managing channels with the user's admin rights). Ordinary
   * shared agents are denied them, so a user's delegated authority cannot be
   * exercised by an agent the user did not delegate to.
   */
  personalAssistantOnly?: boolean
  /**
   * When true, the tool is OFF for every agent by default and is exposed ONLY
   * to an agent whose per-agent `toolPolicy` carries an explicit allow
   * (`toolPolicy[id] === true`). Unlike the ordinary builtin default (enabled
   * unless the policy sets `false`), an absent/inherited verdict does NOT expose
   * the tool. Use for powerful integration builtins (e.g. `deep_water_run_update`)
   * that must be granted deliberately, PA or shared agent alike.
   */
  requiresExplicitGrant?: boolean
  /**
   * The call must pass a human (or auto-review) approval gate before it runs.
   * Declared here in code rather than as a seeded `PolicyRule`, because the
   * policy evaluator's default verdict is `allow` — a purely data-driven gate
   * is absent in any organization whose seed never ran, which is every
   * organization created before the rule existed.
   */
  requiresApproval?: boolean
  /**
   * Optional Zod input schema. Slice F (MCP universal connector) tools require
   * this so the worker can validate args before invoking the handler. Existing
   * builtin tools predate the schema and continue to rely on `parameters`.
   */
  inputSchema?: ZodTypeAny
  /**
   * Optional Zod output schema. When present, the handler's structured output
   * is validated against this schema before being returned to the agent.
   */
  outputSchema?: ZodTypeAny
}
