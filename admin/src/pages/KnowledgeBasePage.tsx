import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { useKnowledgePageDeepLink } from '../components/features/knowledge/useKnowledgePageDeepLink'
import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

export const KnowledgeBasePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { selectProductView } = useKnowledge()
  const deepLinkView = searchParams.get('view')

  // Deep link from elsewhere (an approval's "Open page" link, a search result,
  // a DeepWater research run's native Knowledge document) — shared with the
  // project Docs tab, which accepts the same `?spaceId=&pageId=` params.
  useKnowledgePageDeepLink()

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
