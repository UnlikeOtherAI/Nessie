import { createContext, useContext } from 'react'

/**
 * Which overlay the subtree beneath is rendered inside, read by the anchored
 * primitive so a call site does not have to be told (docs/navigation/overview.md §7).
 *
 * `Popover` has always been able to take the modal-owned layer — but only when
 * its call site remembered to ask for it, and a picker does not know where it
 * has been mounted. `StatusEmojiPicker` is the same component on the status
 * detail page and inside "New status"; on the page it was right at 50, in the
 * dialog the emoji grid opened *underneath* the dialog's own blurred scrim,
 * visible only as smudges of colour through the blur. `PersonPicker` inside
 * `ShareDialog` and `AssigneePicker` inside `TaskDialog` were one open away
 * from the same picture.
 *
 * So the owner announces itself and the popover reads it. An explicit `layer`
 * still wins, for the call site that genuinely knows better.
 */
export type OverlayOwnerKind = 'modal'

const OverlayOwnerContext = createContext<OverlayOwnerKind | null>(null)

export const OverlayOwnerProvider = OverlayOwnerContext.Provider

export const useOverlayOwner = (): OverlayOwnerKind | null => useContext(OverlayOwnerContext)
