export type PersonalAssistantMention = {
  agentId: string
  principalUserId: string
  type: 'agent'
}

export const readPersonalAssistantMentions = (
  editor: HTMLElement | null,
): PersonalAssistantMention[] => {
  if (!editor) return []
  const mentions = new Map<string, PersonalAssistantMention>()
  for (const node of editor.querySelectorAll<HTMLElement>(
    '[data-mention-type="agent"][data-mention-id][data-mention-principal-user-id]',
  )) {
    const agentId = node.dataset.mentionId
    const principalUserId = node.dataset.mentionPrincipalUserId
    if (!agentId || !principalUserId) continue
    const mention = { agentId, principalUserId, type: 'agent' as const }
    mentions.set(`${agentId}:${principalUserId}`, mention)
  }
  return [...mentions.values()]
}
