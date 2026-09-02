import { useEffect } from 'react'
import { useKnowledgePageLookup } from '../../../facades/knowledge/hooks'
import { useConsumedIntents } from '../../../navigation/intent'
import { useKnowledge } from './KnowledgeProvider'

// The document deep link: `?spaceId=&pageId=` (or `?pageId=` alone) opens
// that document in whichever knowledge surface is mounted — the Knowledge
// section or a project's Docs tab. The registry declares both names as
// consumed on every knowledge row (docs/navigation/overview.md §8), so the one intent
// hook captures them and strips them; navigating away and back never
// re-triggers the jump. One implementation, because a second would drift.
//
// A caller that does not know the owning space (a DeepWater run's
// `knowledgePageId`) links with `?pageId=` alone; the space is resolved from
// the page record first.
const PAGE_INTENTS = ['spaceId', 'pageId'] as const

export const useKnowledgePageDeepLink = (): void => {
  const { openPageDeepLink } = useKnowledge()
  const pageLookup = useKnowledgePageLookup()
  const { serial, values } = useConsumedIntents(PAGE_INTENTS)
  const { pageId, spaceId } = values

  useEffect(() => {
    if (!pageId) return undefined
    if (spaceId) {
      openPageDeepLink({ pageId, spaceId })
      return undefined
    }
    // Cancellation is scoped to unmount and to the next arrival only; the
    // captured values are stable through the strip, so nothing here re-runs
    // and cancels the in-flight lookup before it resolves.
    let cancelled = false
    void pageLookup
      .mutateAsync(pageId)
      .then((page) => {
        if (cancelled) return
        openPageDeepLink({ pageId: page.id, spaceId: page.spaceId })
      })
      .catch(() => {
        // Page no longer exists / not visible to this user — nothing to open.
      })
    return () => {
      cancelled = true
    }
    // `pageLookup` is intentionally not a dependency: useMutation returns a
    // new object every render, so depending on it would re-fire the lookup
    // forever. `serial` makes the same document linked twice open twice.
  }, [openPageDeepLink, pageId, serial, spaceId])
}
