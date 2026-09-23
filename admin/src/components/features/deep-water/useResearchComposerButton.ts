import { useDeepWaterReadiness } from '../../../facades/deep-water/hooks'
import type { NewBriefPlace } from './research-brief-origin'
import { researchButtonTitle } from './research-presentation'
import { useResearchBriefDoorway } from './ResearchBriefHost'

export type ResearchComposerButton = {
  onOpen: () => void
  /** The accessible name and tooltip: what it does, and why it would not open a brief yet. */
  title: string
}

/**
 * A composer's Research button (nessie.md §7.7 doorways). It is on every
 * composer a person can post from — the conversation's, a reply thread's, a
 * Threads inbox card's and the agent and person drawers' — and always there: a
 * person who cannot start research yet presses it and is told why, with the
 * way forward, rather than finding nothing. It opens a new brief pre-filled
 * with whatever they had typed, which stays in the composer, and the brief
 * comes back to the conversation that composer posts to (`place`: a reply
 * thread's root, or a conversation other than the screen's own). Undefined
 * only where no brief host is mounted to open it.
 */
export const useResearchComposerButton = (
  message: string,
  place?: NewBriefPlace,
): ResearchComposerButton | undefined => {
  const readiness = useDeepWaterReadiness()
  const doorway = useResearchBriefDoorway()
  const openNew = doorway.openNew
  if (!openNew) return undefined
  return {
    onOpen: () => openNew(message.trim(), place),
    title: researchButtonTitle(readiness.isLoading ? null : readiness.state, readiness.viewerCanChangeTeam),
  }
}
