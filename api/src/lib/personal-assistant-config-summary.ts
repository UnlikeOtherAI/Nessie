import { PersonalAssistantConfigSummarySchema, parseAgentId } from '@nessie/schemas'

/**
 * The Personal Assistant state's `configSummary`: model, provider, a prompt
 * preview and the enabled tool ids. A pure mapping over the agent row, kept
 * out of `createRequestHelpers` because it closes over nothing — and so that
 * factory stays under the 500-line cap (AGENTS.md).
 */
export const buildPersonalAssistantConfigSummary = (agent: {
  id: string
  model: string | null
  provider: string | null
  systemPrompt: string | null
  toolPolicy: unknown
  updatedAt: Date
}) =>
  PersonalAssistantConfigSummarySchema.parse({
    agentId: parseAgentId(agent.id),
    model: agent.model ?? undefined,
    provider: agent.provider ?? undefined,
    systemPromptPreview: agent.systemPrompt?.slice(0, 200) ?? undefined,
    toolIds:
      agent.toolPolicy
      && typeof agent.toolPolicy === 'object'
      && !Array.isArray(agent.toolPolicy)
        ? Object.entries(agent.toolPolicy as Record<string, unknown>)
            .filter(([, enabled]) => enabled === true)
            .map(([toolId]) => toolId)
            .sort()
        : [],
    updatedAt: agent.updatedAt.toISOString(),
  })
