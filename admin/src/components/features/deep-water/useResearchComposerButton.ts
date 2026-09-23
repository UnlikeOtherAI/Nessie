import { useDeepWaterReadiness } from '../../../facades/deep-water/hooks'
import { researchButtonTitle } from './research-presentation'
import { useResearchBriefDoorway } from './ResearchBriefHost'

export type ResearchComposerButton = {
  onOpen: () => void
  /** The accessible name and tooltip: what it does, and why it would not open a brief yet. */
  title: string
}

/**
 * The composer's Research button (nessie.md §7.7 doorways). It is always
 * there — a person who cannot start research yet presses it and is told why,
 * with the way forward, rather than finding nothing — and it opens a new brief
 * pre-filled with whatever they had typed, which stays in the composer.
 * Undefined only where no brief host is mounted to open it.
 */
export const useResearchComposerButton = (message: string): ResearchComposerButton | undefined => {
  const readiness = useDeepWaterReadiness()
  const doorway = useResearchBriefDoorway()
  const openNew = doorway.openNew
  if (!openNew) return undefined
  return {
    onOpen: () => openNew(message.trim()),
    title: researchButtonTitle(readiness.state, readiness.viewerCanChangeTeam),
  }
}
