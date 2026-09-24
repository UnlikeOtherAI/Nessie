import { DocumentChangedStoredConfigSchema, type AgentTriggerRecord } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import type { ActingMember } from './access.js'
import { recordKnowledgeSpaceRead } from './knowledge-basis.js'
import { describeTicketTriggerScope } from './provisioning-ticket-trigger.js'

/**
 * What a `document_changed` trigger resolved to, said back after
 * `agent_trigger_create` or `agent_trigger_update` (docs/standards/document-triggers.md):
 * the space it stored by id — named, or implied by the folder, pages or the
 * project's Documents space — the narrowing, and when it wakes the agent.
 *
 * The acting member passed the create's own check that they can read the
 * space, so its name is theirs to read; it stamps the space as a listing
 * does. A folder or page is named by id only: its title was not read.
 */
export const describeDocumentTriggerScope = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  trigger: AgentTriggerRecord,
): Promise<string[]> => {
  if (trigger.type !== 'document_changed') return []
  const parsed = DocumentChangedStoredConfigSchema.safeParse(trigger.config)
  if (!parsed.success) return []
  const config = parsed.data
  const space = await context.prisma.knowledgeSpace.findFirst({
    where: { id: config.spaceId, organizationId: member.organizationId, deletedAt: null },
    select: {
      id: true, name: true, organizationId: true, ownerAgentId: true, projectId: true, teamId: true,
      channelId: true, userId: true, visibility: true,
    },
  })
  if (!space) return []
  recordKnowledgeSpaceRead(context, [space])
  const narrowing = [
    ...(config.folderPageId ? [`inside the folder pageId=${config.folderPageId}`] : []),
    ...(config.pageIds ? [`only pageIds ${config.pageIds.join(', ')}`] : []),
    ...(config.labels ? [`only pages labelled ${config.labels.join(' or ')}`] : []),
  ]
  return [
    `Watches ${config.kinds.join(' and ')} pages of the space ${space.name} (spaceId=${space.id})`
    + (narrowing.length > 0 ? `, ${narrowing.join(', ')}` : ''),
    `Wakes the agent ${config.quietSeconds} seconds after the first ${config.fireOn === 'save' ? 'save' : 'publish'}`
    + ' of a quiet window, once for every change in it'
    + (config.includeAgentEdits ? '; other agents\' saves count too' : '; only people\'s saves count'),
  ]
}

/** Whatever a ticket or document trigger resolved to; nothing for any other type. */
export const describeResolvedTriggerScope = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  trigger: AgentTriggerRecord,
): Promise<string[]> => [
  ...await describeTicketTriggerScope(context, member, trigger),
  ...await describeDocumentTriggerScope(context, member, trigger),
]
