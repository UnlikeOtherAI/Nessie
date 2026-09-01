import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useKnowledgePageLookup } from '../../../facades/knowledge/hooks'
import { useKnowledge } from './KnowledgeProvider'

/**
 * `?spaceId=&pageId=` (or `?pageId=` alone) opens that document in whichever
 * knowledge surface is mounted — the Knowledge section or a project's Docs tab
 * — then clears the params so navigating away and back doesn't re-trigger the
 * jump. One implementation, because a second one would drift.
 *
 * Callers that don't know the owning space (e.g. a DeepWater run's
 * `knowledgePageId`) may link with just `?pageId=`; the space is resolved from
 * the page record first.
 */
export const useKnowledgePageDeepLink = (): void => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { openPageDeepLink } = useKnowledge()
  const pageLookup = useKnowledgePageLookup()
  const deepLinkSpaceId = searchParams.get('spaceId')
  const deepLinkPageId = searchParams.get('pageId')

  useEffect(() => {
    if (!deepLinkPageId) return undefined
    // Cancellation is scoped to unmount only. We must NOT clear the search params
    // up front: doing so flips `deepLinkPageId` to null, which re-runs this effect
    // and fires the cleanup — cancelling the in-flight lookup before it resolves,
    // so the doc never opens. Instead, open first, then clear the params (after
    // the async lookup resolves for the pageId-only path).
    let cancelled = false

    if (deepLinkSpaceId) {
      openPageDeepLink({ pageId: deepLinkPageId, spaceId: deepLinkSpaceId })
      setSearchParams({}, { replace: true })
      return () => {
        cancelled = true
      }
    }

    void pageLookup
      .mutateAsync(deepLinkPageId)
      .then((page) => {
        if (cancelled) return
        openPageDeepLink({ pageId: page.id, spaceId: page.spaceId })
        setSearchParams({}, { replace: true })
      })
      .catch(() => {
        // Page no longer exists / not visible to this user — nothing to open.
      })
    return () => {
      cancelled = true
    }
    // `pageLookup` is intentionally not a dependency: useMutation returns a new
    // object every render, so depending on it would re-fire the lookup forever.
  }, [deepLinkPageId, deepLinkSpaceId, openPageDeepLink, setSearchParams])
}
