/**
 * How far the software keyboard reaches up into the window, in points.
 *
 * WKWebView does not resize its page for the keyboard: the layout viewport
 * keeps its full height and WebKit pans the whole document up to reveal the
 * focused field. The admin cannot undo that pan, and its own keyboard inset
 * (`--keyboard-inset`) then lifted the composer a second time — the composer
 * floated far above the keyboard and the messages above it slid out of view.
 * Ending the WebView frame at the keyboard's top edge instead gives the page a
 * genuinely shorter viewport, the way Android's `adjustResize` does: nothing
 * is covered, so WebKit never pans and the page's inset measures zero.
 */
export const keyboardOverlapHeight = (windowHeight: number, keyboardTop: number): number => {
  if (!Number.isFinite(windowHeight) || !Number.isFinite(keyboardTop)) return 0
  return Math.max(0, Math.round(windowHeight - keyboardTop))
}
