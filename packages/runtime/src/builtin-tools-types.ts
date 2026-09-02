import type { ToolCategoryId } from '@nessie/schemas'
import type { ZodTypeAny } from 'zod'

export type BuiltinToolDefinition = {
  id: string
  summary: string
  description: string
  label: string
  /**
   * Where this tool belongs in every surface that lists tools. Required, and
   * deliberately so: the admin used to guess a category from the id prefix and
   * sweep the remainder into one bucket that grew to hold 75 of 116 builtins.
   * A new tool now has to say where it lives, or it does not compile.
   */
  category: ToolCategoryId
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
   * Narrows `personalAssistantOnly` to the identity-delegated arm alone: the
   * tool acts as the requesting person, but the Personal Assistant may NOT call
   * it — only a global agent whose blueprint names it in `identityToolIds`,
   * inside its own home DM, on an interactive human turn.
   *
   * This is how a capability is moved from the PA to a specialist without
   * deleting it: designing an agent is the Agent Designer's job, and the design
   * catalogue is large enough that it belongs in one agent's context. The PA
   * keeps the operational verbs on agents that already exist (list, bind,
   * schedule) and routes creation and redesign through `agent_handoff`.
   *
   * Meaningless without `personalAssistantOnly` — it only ever removes the
   * kind-based arm — so the two are declared together.
   */
  identityDelegatedOnly?: boolean
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
