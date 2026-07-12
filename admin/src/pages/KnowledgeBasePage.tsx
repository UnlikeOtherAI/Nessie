import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useKnowledgePageLookup } from '../facades/knowledge/hooks'
import { useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

export const KnowledgeBasePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { openPageDeepLink, selectProductView } = useKnowledge()
  const pageLookup = useKnowledgePageLookup()
  const deepLinkSpaceId = searchParams.get('spaceId')
  const deepLinkPageId = searchParams.get('pageId')
  const deepLinkView = searchParams.get('view')

  // Deep link from elsewhere (an approval's "Open page" link, a search
  // result, a DeepWater research run's native Knowledge document): jump
  // straight to the page, then clear the params so navigating away and back
  // doesn't re-trigger the jump. Callers that don't know the page's owning
  // space up front (e.g. `DeepWaterResearchRunRecord.knowledgePageId`, which
  // carries no spaceId) can link with just `?pageId=`; the space is then
  // resolved from the page record itself before opening it.
  useEffect(() => {
    if (!deepLinkPageId) return
    setSearchParams({}, { replace: true })

    if (deepLinkSpaceId) {
      openPageDeepLink({ pageId: deepLinkPageId, spaceId: deepLinkSpaceId })
      return
    }

    let cancelled = false
    void pageLookup
      .mutateAsync(deepLinkPageId)
      .then((page) => {
        if (!cancelled) openPageDeepLink({ pageId: page.id, spaceId: page.spaceId })
      })
      .catch(() => {
        // Page no longer exists / not visible to this user — nothing to open.
      })
    return () => {
      cancelled = true
    }
  }, [deepLinkPageId, deepLinkSpaceId, openPageDeepLink, setSearchParams])

  // Deep link to a product Documents view (e.g. the Integrations page's "Open
  // Research" link → /knowledge-base?view=deep-water-research).
  useEffect(() => {
    if (!deepLinkView) return
    selectProductView(deepLinkView)
    setSearchParams({}, { replace: true })
  }, [deepLinkView, selectProductView, setSearchParams])

  return (
    <div className="flex h-full flex-col">
      <MobileSectionHeader title="Knowledge" />
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace />
      </div>
    </div>
  )
}
