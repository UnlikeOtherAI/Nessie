// The Android dock overlays the WebView. Keep the native geometry and the CSS
// interaction clearance in one place so the chat composer never falls under it.
export const ANDROID_TABLET_TAB_BAR_HEIGHT = 70
export const ANDROID_TABLET_TAB_BAR_BOTTOM_GAP = 8
// Keep the composer comfortably clear of the dock without making it look
// visually detached from the primary navigation.
export const ANDROID_TABLET_TAB_BAR_CONTENT_GAP = 8
export const ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE =
  ANDROID_TABLET_TAB_BAR_HEIGHT
  + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP
  + ANDROID_TABLET_TAB_BAR_CONTENT_GAP

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
}): number => {
  if (!input.dockShowing) return 0
  const inset = Number.isFinite(input.bottomInset) ? Math.max(0, input.bottomInset) : 0
  return ANDROID_TABLET_TAB_BAR_CONTENT_CLEARANCE + inset
}
