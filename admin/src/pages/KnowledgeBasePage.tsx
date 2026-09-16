import { useEffect } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { useKnowledgePageDeepLink } from '../components/features/knowledge/useKnowledgePageDeepLink'
import { KnowledgeWorkspace } from '../components/features/knowledge/KnowledgeWorkspace'

/**
 * The Knowledge section's one page. Every route under `/knowledge-base` lands
 * here and says which root row is open; the Finder is the same component
 * either way, so a sibling swap is a selection change rather than a remount.
 *
 * There is no `ScreenHeader` here. The Finder's root column *is* the screen —
 * `ColumnBrowserColumn screen` renders the `h1` and the toolbar — which is
 * what lets the column carry the actions on both layouts instead of a header
 * above it carrying them on one.
 */
export const KnowledgeBasePage = () => {
  const { pathname } = useLocation()
  const { productView, spaceId } = useParams<{
    productView?: string
    spaceId?: string
  }>()
  const {
    activeProductView,
    selectedRoot,
    selectedSpaceId,
    selectProductView,
    selectSpace,
    selectVirtual,
  } = useKnowledge()

  // Deep link from elsewhere (an approval's "Open page" link, a search result,
  // a DeepWater research run's native Knowledge document) — shared with the
  // project Docs tab, which accepts the same `?spaceId=&pageId=` params.
  useKnowledgePageDeepLink()

  // The routes are addressable so the phone shell can keep and animate the
  // outgoing screen. Sync them back into the shared browser, so a cold deep
  // link opens the same content.
  useEffect(() => {
    if (spaceId && selectedSpaceId !== spaceId) selectSpace(spaceId)
  }, [selectedSpaceId, selectSpace, spaceId])

  useEffect(() => {
    if (productView && activeProductView !== productView) selectProductView(productView)
  }, [activeProductView, productView, selectProductView])

  useEffect(() => {
    const wanted = pathname.endsWith('/latest')
      ? 'latest'
      : pathname.endsWith('/shared-with-me')
        ? 'shared-with-me'
        : null
    if (wanted && selectedRoot?.kind !== wanted) selectVirtual(wanted)
  }, [pathname, selectedRoot, selectVirtual])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace />
      </div>
    </div>
  )
}
