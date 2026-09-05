import { useState } from 'react'
import type { ApiClient } from '../../../../lib/api-client'
import { useApiClient } from '../../../../providers/ApiClientProvider'
import { useKnowledge } from '../KnowledgeProvider'

export type WikilinkCreateConfirmState = {
  title: string
  at: { top: number; left: number }
}

// Resolved wikilinks only carry the target page id, not its space, so a click
// needs one extra lookup before it can deep-link. Cached in-module (keyed by
// pageId) since the same target is commonly clicked more than once per
// session and its space never changes.
const spaceIdCache = new Map<string, string>()

const resolvePageSpaceId = async (apiClient: ApiClient, pageId: string): Promise<string | null> => {
  const cached = spaceIdCache.get(pageId)
  if (cached) return cached
  try {
    const page = await apiClient.get<{ spaceId: string }>(`/api/knowledge-base/pages/${pageId}`)
    spaceIdCache.set(pageId, page.spaceId)
    return page.spaceId
  } catch {
    return null
  }
}

// Wires up click behavior for wikilink anchors rendered by RichTextContent:
// resolved links deep-link straight to their target page; unresolved links
// open a small confirm popover that creates the page (in the current space)
// via the existing create-page flow.
export const useWikilinkNavigation = () => {
  const apiClient = useApiClient()
  const { openCreate, openPageDeepLink } = useKnowledge()
  const [confirmCreate, setConfirmCreate] = useState<WikilinkCreateConfirmState | null>(null)

  const navigateToPage = (pageId: string) => {
    void resolvePageSpaceId(apiClient, pageId).then((spaceId) => {
      if (spaceId) openPageDeepLink({ spaceId, pageId })
    })
  }

  const requestCreate = (title: string, at: { top: number; left: number }) => {
    setConfirmCreate({ title, at })
  }

  const cancelCreate = () => setConfirmCreate(null)

  const confirmCreateNow = () => {
    if (!confirmCreate) return
    openCreate(null, confirmCreate.title)
    setConfirmCreate(null)
  }

  return { confirmCreate, navigateToPage, requestCreate, cancelCreate, confirmCreateNow }
}
