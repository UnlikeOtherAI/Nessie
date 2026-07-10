import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

export const KnowledgeBasePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { openPageDeepLink } = useKnowledge()
  const deepLinkSpaceId = searchParams.get('spaceId')
  const deepLinkPageId = searchParams.get('pageId')

  // Deep link from elsewhere (an approval's "Open page" link, a search
  // result): jump straight to the page, then clear the params so navigating
  // away and back doesn't re-trigger the jump.
  useEffect(() => {
    if (!deepLinkSpaceId || !deepLinkPageId) return
    openPageDeepLink({ pageId: deepLinkPageId, spaceId: deepLinkSpaceId })
    setSearchParams({}, { replace: true })
  }, [deepLinkPageId, deepLinkSpaceId, openPageDeepLink, setSearchParams])

  return (
    <div className="flex h-full flex-col">
      <MobileSectionHeader title="Knowledge" />
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace />
      </div>
    </div>
  )
}
