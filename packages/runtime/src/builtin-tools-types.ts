import type { ZodTypeAny } from 'zod'

export type BuiltinToolDefinition = {
  id: string
  description: string
  label: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  safe: boolean
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
