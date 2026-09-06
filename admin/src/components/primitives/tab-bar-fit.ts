/**
 * The one decision behind TabBar's two shapes: does the strip still fit the
 * width it was given, or has it become a dropdown?
 *
 * It is a pure function of two lengths so it can be asserted directly. The
 * component cannot: the measurement it feeds this arrives through a
 * ResizeObserver, which browsers only deliver on a rendering frame — a hidden
 * tab, a headless screenshot pass and a background pane all stop delivering
 * one, so a test driving the real component would be measuring the harness.
 */

/** Sub-pixel layout noise — a half-pixel label is not a reason to collapse. */
export const TAB_BAR_FIT_TOLERANCE = 1

export type TabBarFit = {
  /** Width available to the strip: the box it must live inside. */
  available: number
  /** The current shape, kept whenever a reading is not trustworthy. */
  collapsed: boolean
  /**
   * Width the strip needs with every label laid out. `null` before anything
   * has been measured — the first render is always a strip, so the very first
   * reading comes from the strip itself.
   */
  natural: number | null
}

/**
 * `natural` does not depend on the shape being measured, and `available` is
 * the container's width either way, so the answer cannot feed back into its
 * own input: a strip that fits stays a strip, and a dropdown that would fit
 * becomes a strip once and stays one. That is what keeps a boundary width from
 * oscillating between the two.
 *
 * A zero or negative `available` is not a width — a closed panel and a screen
 * mid-transition both measure zero — so the current shape is kept rather than
 * reading "nothing fits" into it.
 */
export const decideTabBarCollapse = ({ available, collapsed, natural }: TabBarFit): boolean => {
  if (natural === null || available <= 0) return collapsed
  return natural > available + TAB_BAR_FIT_TOLERANCE
}
