// The Android dock overlays the WebView. Keep the native geometry and the CSS
// interaction clearance in one place so the chat composer never falls under it.
//
// The dock has two shapes, and orientation is the only thing that chooses
// between them. Portrait stacks each label under its icon in a tall pill
// raised off the floor. Landscape has far less height to spend — the same pill
// and gap took a tenth of a 10-inch tablet's screen turned sideways — so there
// the label sits beside its icon in a shorter pill resting nearer the floor.
// Same tabs, same targets, lower and flatter.
export const ANDROID_TABLET_TAB_BAR_HEIGHT = 70
export const ANDROID_TABLET_TAB_BAR_BOTTOM_GAP = 8
export const ANDROID_TABLET_LANDSCAPE_TAB_BAR_HEIGHT = 50
export const ANDROID_TABLET_LANDSCAPE_TAB_BAR_BOTTOM_GAP = 2
// Keep the composer comfortably clear of the dock without making it look
// visually detached from the primary navigation.
export const ANDROID_TABLET_TAB_BAR_CONTENT_GAP = 8
export const ANDROID_TABLET_LANDSCAPE_TAB_BAR_CONTENT_GAP = 6

export type AndroidDockGeometry = {
  // Between the pill's bottom edge and the safe-area floor.
  bottomGap: number
  // The pill, both gaps, and nothing else: what a page keeps clear at its
  // bottom edge before the safe-area inset is added to it.
  contentClearance: number
  // The pill's own height.
  height: number
}

/**
 * The dock's shape for an orientation.
 *
 * Every other bottom measurement in the shell derives from this one answer —
 * where the pill is drawn, what the page reserves, where the floating creation
 * control sits — so a rotation can never leave one of them holding the other
 * orientation's number. A page reserving the portrait pill's height under the
 * landscape pill is the same defect as reserving a dock that is not drawn.
 */
export const androidDockGeometry = (landscape: boolean): AndroidDockGeometry => {
  const height = landscape
    ? ANDROID_TABLET_LANDSCAPE_TAB_BAR_HEIGHT
    : ANDROID_TABLET_TAB_BAR_HEIGHT
  const bottomGap = landscape
    ? ANDROID_TABLET_LANDSCAPE_TAB_BAR_BOTTOM_GAP
    : ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
  const contentGap = landscape
    ? ANDROID_TABLET_LANDSCAPE_TAB_BAR_CONTENT_GAP
    : ANDROID_TABLET_TAB_BAR_CONTENT_GAP

  return { bottomGap, contentClearance: height + bottomGap + contentGap, height }
}

export const ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE = androidDockGeometry(false).contentClearance
export const ANDROID_TABLET_LANDSCAPE_TAB_BAR_CONTENT_CLEARANCE =
  androidDockGeometry(true).contentClearance

/**
 * Whether the dock is a thing the page has to keep clear of.
 *
 * Not the same question as whether the dock is drawn. While the soft keyboard
 * is up the dock stays at the window's floor, *behind* the keyboard: measured
 * on a Lenovo TB336FU, the page shortens itself to the keyboard's top edge
 * while the dock does not move, so a page that still reserved the dock's
 * height left an 86dp hole between the composer and the keyboard — the gap
 * this shell was reported for, one taskbar smaller.
 *
 * The admin's own `100lvh - 100dvh` arithmetic cannot see this: both units
 * shorten together on that device, so the subtraction is a no-op there. It
 * stays as the answer for a WebView whose page keeps its full height while
 * the keyboard covers it; this is the answer for one that does not.
 */
export const androidDockShowing = (input: {
  keyboardOpen: boolean
  showBar: boolean
}): boolean => input.showBar && !input.keyboardOpen

/**
 * What the page must keep clear at its bottom edge for the dock.
 *
 * The WebView runs to the bottom of the window and the dock floats over it, so
 * this is the only bottom clearance the page gets: the shell publishes it, and
 * `admin/src/styles.css` owns every selector that spends it. Zero while the
 * dock is not drawn — a full-screen task route, or the login gate — because a
 * page that reserves room for a control nobody can see is a page with a hole
 * in it.
 *
 * The safe-area inset is added here rather than left to the page's own
 * `env(safe-area-inset-bottom)`: the WebView reports the system bars' inset to
 * CSS whether or not this shell has already accounted for it, and a page that
 * spends both ends up a taskbar's height short of its own floor.
 */
export const androidDockContentClearance = (input: {
  bottomInset: number
  dockShowing: boolean
  landscape: boolean
}): number => {
  if (!input.dockShowing) return 0
  const inset = Number.isFinite(input.bottomInset) ? Math.max(0, input.bottomInset) : 0
  return androidDockGeometry(input.landscape).contentClearance + inset
}
