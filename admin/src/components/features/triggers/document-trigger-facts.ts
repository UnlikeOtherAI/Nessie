import { DocumentChangedStoredConfigSchema } from '@nessie/schemas'

import { useKnowledgePages, useKnowledgeSpace } from '../../../facades/knowledge/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import type { KeyValueItem } from '../../shared/KeyValueList'
import { documentKindsWord, formatQuietWindow } from './document-trigger-presentation'

/**
 * A document trigger's facts on its own page, named: which space, which
 * folder and pages, which labels, and what wakes the agent. The stored config
 * holds ids (the server resolved them), so the names come from the space's
 * own reads — which answer only a viewer who may read the space, and say so
 * otherwise rather than printing an id.
 */
export const useDocumentTriggerFacts = (trigger: AgentTriggerRecord): KeyValueItem[] => {
  const isDocument = trigger.type === 'document_changed'
  const parsed = isDocument ? DocumentChangedStoredConfigSchema.safeParse(trigger.config) : null
  const config = parsed?.success ? parsed.data : null
  const spaceQuery = useKnowledgeSpace(config?.spaceId)
  const namesPages = Boolean(config?.folderPageId || config?.pageIds)
  const pagesQuery = useKnowledgePages(namesPages ? config?.spaceId : undefined)
  if (!isDocument) return []
  if (!config) return [{ label: 'Watches', value: 'This trigger’s configuration needs attention.' }]

  const unreadable = spaceQuery.isError || pagesQuery.isError
  const title = (id: string): string => {
    const page = pagesQuery.data?.find((candidate) => candidate.id === id)
    if (page) return page.title
    return unreadable ? 'a page you cannot open' : pagesQuery.isLoading ? '…' : 'a removed page'
  }
  const kinds = documentKindsWord(config.kinds)
  return [
    { label: 'Space', value: spaceQuery.data?.name ?? (spaceQuery.isError ? 'A space you cannot open' : '…') },
    ...(config.folderPageId ? [{ label: 'Folder', value: title(config.folderPageId) }] : []),
    ...(config.pageIds ? [{ label: 'Pages', value: config.pageIds.map(title).join(', ') }] : []),
    ...(config.labels ? [{ label: 'Labels', value: `Only pages labelled ${config.labels.join(' or ')}` }] : []),
    { label: 'Watches', value: `${kinds.charAt(0).toUpperCase()}${kinds.slice(1)}; never a spreadsheet` },
    {
      label: 'Wakes the agent',
      value: `${formatQuietWindow(config.quietSeconds)} after the first ${config.fireOn === 'publish' ? 'publish' : 'save'}, `
        + 'once for every change in that window',
    },
    {
      label: 'Agent edits',
      value: config.includeAgentEdits
        ? 'Another agent’s saves wake it too; its own never do'
        : 'Only people’s saves wake it',
    },
  ]
}
