import {
  isPhoneBackSwipeHorizontal,
  isPhoneBackSwipeVertical,
  phoneBackSwipeVelocity,
  resolvePhoneBackSwipeOutcome,
  type PhoneBackSwipeOutcome,
  type PhoneBackSwipeSample,
} from '../../layouts/admin-shell/phone-navigation-gesture'
import type { SheetSide } from '../../navigation/overlay'

// Swipe-to-close for a Sheet, along the sheet's own axis. It is the phone
// back-swipe's decision logic re-pointed at an edge: the raw samples are
// projected onto "distance travelled toward the sheet's edge" and handed to
// the same velocity estimator and the same commit rule, so a drawer and a
// screen agree on what counts as a flick. Nothing here restates a threshold.

// How far a finger has travelled toward the sheet's own edge, in px.
export const sheetEdgeTravel = (
  side: SheetSide,
  dx: number,
  dy: number,
): number => (side === 'left' ? -dx : side === 'right' ? dx : dy)

// The drag is claimed only once it is unambiguously along the sheet's axis,
// using the shared slop and dominance rule.
export const isSheetSwipeAligned = (
  side: SheetSide,
  dx: number,
  dy: number,
): boolean => (side === 'bottom'
  ? isPhoneBackSwipeVertical(dx, dy)
  : isPhoneBackSwipeHorizontal(dx, dy))

// Project the gesture onto its edge axis so `phoneBackSwipeVelocity` — which
// reads `clientX` — measures speed toward the edge whatever the side is.
const projectSamples = (
  side: SheetSide,
  samples: readonly PhoneBackSwipeSample[],
): PhoneBackSwipeSample[] => {
  const first = samples[0]
  if (!first) return []
  return samples.map((sample) => ({
    clientX: sheetEdgeTravel(
      side,
      sample.clientX - first.clientX,
      sample.clientY - first.clientY,
    ),
    clientY: 0,
    time: sample.time,
  }))
}

export type SheetSwipeOutcomeInput = {
  // Panel extent along the swipe axis, in px. A zero extent cannot produce
  // progress, so the gesture cancels rather than closing on a stray touch.
  extentPx: number
  samples: readonly PhoneBackSwipeSample[]
  side: SheetSide
}

export const resolveSheetSwipeOutcome = ({
  extentPx,
  samples,
  side,
}: SheetSwipeOutcomeInput): PhoneBackSwipeOutcome => {
  const projected = projectSamples(side, samples)
  const travel = projected.at(-1)?.clientX ?? 0
  if (extentPx <= 0 || travel <= 0) return 'cancel'
  return resolvePhoneBackSwipeOutcome({
    progress: travel / extentPx,
    velocity: phoneBackSwipeVelocity(projected),
  })
}

export type { PhoneBackSwipeSample }
