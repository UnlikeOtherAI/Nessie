import { AgentMentionSchema, type AgentMention } from '@nessie/schemas'

/** Read the durable identities behind the agent tags inserted by the picker. */
export const readAgentMentions = (
  editor: HTMLElement | null,
): AgentMention[] => {
  if (!editor) return []
  const mentions = new Map<string, AgentMention>()
  for (const node of editor.querySelectorAll<HTMLElement>(
    '[data-mention-type="agent"][data-mention-id]',
  )) {
    const agentId = node.dataset.mentionId
    const principalUserId = node.dataset.mentionPrincipalUserId
    if (!agentId) continue
    const parsed = AgentMentionSchema.safeParse({
      agentId,
      ...(principalUserId ? { principalUserId } : {}),
      type: 'agent',
    })
    if (!parsed.success) continue
    const mention = parsed.data
    mentions.set(`${agentId}:${principalUserId ?? ''}`, mention)
  }
  return [...mentions.values()]
}
