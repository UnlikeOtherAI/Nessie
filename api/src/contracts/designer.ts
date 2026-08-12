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

// Catalog of tools the designer model may toggle. Sent by the admin so the
// prompt reflects the org's real tool registry instead of a hardcoded list.
export const DesignerToolDescriptorSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  kind: z.enum(['builtin', 'mcp']).optional(),
})

export const DesignerChatBodySchema = z.object({
  messages: z.array(DesignerChatMessageSchema),
  formState: DesignerFormStateSchema,
  availableTools: z.array(DesignerToolDescriptorSchema).optional(),
  // The same catalogue the model combobox renders (`GET /api/agents/models`),
  // in the same order. The designer cannot pick a model out of a catalogue it
  // cannot see, and the pair it names has to be one the form can resolve.
  availableModels: z.array(AgentModelOptionSchema).optional(),
})
