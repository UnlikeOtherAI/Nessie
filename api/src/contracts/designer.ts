import { AgentModelOptionSchema } from '@nessie/schemas'
import { z } from 'zod'

// ─── Designer chat ────────────────────────────────────────────────────────

export const DesignerChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

export const DesignerFormStateSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  tools: z.record(z.string(), z.boolean()),
})

// The assistant is one panel shared across the agent's tabs. This is a
// concrete description of the current page, not a second source of UI state.
export const DesignerPageContextSchema = z.object({
  actions: z.array(z.string()),
  description: z.string(),
  title: z.string(),
})

export const DesignerChatBodySchema = z.object({
  messages: z.array(DesignerChatMessageSchema),
  formState: DesignerFormStateSchema,
  // There is deliberately no `availableTools` here any more. The browser used
  // to send the tool list, which made the sidebar's knowledge of this
  // team a client-supplied fact and let the two faces of the Agent
  // Designer disagree; the service now reads the member-safe
  // `loadAgentToolCatalog` projection, the same one `agent_tool_catalog`
  // answers from.
  //
  // The same catalogue the model combobox renders (`GET /api/agents/models`),
  // in the same order. The designer cannot pick a model out of a catalogue it
  // cannot see, and the pair it names has to be one the form can resolve.
  availableModels: z.array(AgentModelOptionSchema).optional(),
  pageContext: DesignerPageContextSchema.optional(),
})

/**
 * "Continue in chat": the sidebar's draft, handed to the person's own Agent
 * Designer conversation. Only the form — the chat transcript stays with the
 * panel, which is ephemeral by design.
 */
export const DesignerContinueBodySchema = z.object({
  formState: DesignerFormStateSchema,
  /** Set when the draft is an edit of an existing agent rather than a new one. */
  editingAgentId: z.string().uuid().optional(),
})
export type DesignerContinueInput = z.infer<typeof DesignerContinueBodySchema>

export const DesignerContinueResultSchema = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
  /** False when the conversation was busy and the draft is queued behind it. */
  started: z.boolean(),
  threadId: z.string().uuid(),
})
