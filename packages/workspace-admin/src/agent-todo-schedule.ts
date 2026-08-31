import { agentTodoScheduledKickoffMetadata } from './agent-todo-kickoff.js'

/** Extract the optional scheduled to-do reference from otherwise-open JSON. */
export const readAgentTodoTemplateIdFromTriggerConfig = (
  config: unknown,
): string | null => {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null
  const todoTemplateId = config['todoTemplateId' as keyof typeof config]
  return typeof todoTemplateId === 'string' ? todoTemplateId : null
}

/**
 * The direct worker fire and API manual-fire paths make the same opaque
 * provenance marker. Materialization happens later, after a run owns the
 * thread slot, so this helper never creates an instance itself.
 */
export const prepareScheduledAgentTodoTrigger = (input: {
  config: unknown
  triggerId: string
}): { metadata: ReturnType<typeof agentTodoScheduledKickoffMetadata>; todoTemplateId: string } | null => {
  const todoTemplateId = readAgentTodoTemplateIdFromTriggerConfig(input.config)
  if (!todoTemplateId) return null
  return {
    metadata: agentTodoScheduledKickoffMetadata([{
      templateId: todoTemplateId,
      triggerId: input.triggerId,
    }]),
    todoTemplateId,
  }
}
