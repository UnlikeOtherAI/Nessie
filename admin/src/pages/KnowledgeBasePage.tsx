import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { useKnowledgePageDeepLink } from '../components/features/knowledge/useKnowledgePageDeepLink'
import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'
import { ScreenHeader } from '../components/shared/ScreenHeader'

export const KnowledgeBasePage = () => {
  const { productView, spaceId } = useParams<{
    productView?: string
    spaceId?: string
  }>()
  const {
    activeProductView,
    selectedSpaceId,
    selectProductView,
    selectSpace,
  } = useKnowledge()

  // Deep link from elsewhere (an approval's "Open page" link, a search result,
  // a DeepWater research run's native Knowledge document) — shared with the
  // project Docs tab, which accepts the same `?spaceId=&pageId=` params.
  useKnowledgePageDeepLink()

  // Phone list selections have addressable child routes so the shell can keep
  // and animate the outgoing list. Sync those routes back into the shared
  // Knowledge workspace as well, so a cold deep link opens the same content.
  useEffect(() => {
    if (spaceId && selectedSpaceId !== spaceId) {
      selectSpace(spaceId)
    }
  }, [selectedSpaceId, selectSpace, spaceId])

  useEffect(() => {
    if (productView && activeProductView !== productView) {
      selectProductView(productView)
    }
  }, [activeProductView, productView, selectProductView])

  return (
    <div className="flex h-full flex-col">
      {/* singleLayoutOnly: on a split layout the section's own list is the
          pinned column and the workspace's panes carry their own chrome, so
          the bar paints only where it is the screen's own header. The screen
          is published either way, so the tab title and the native shell name
          it on both. */}
      <ScreenHeader singleLayoutOnly title="Knowledge" />
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace />
      </div>
    </div>
  )
}
