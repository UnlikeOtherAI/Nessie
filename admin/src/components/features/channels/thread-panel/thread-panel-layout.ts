/**
 * The reply panel's own constants.
 *
 * The width itself is geometry the panel shares with every other resizable
 * side panel — that lives in `hooks/useSidePanelGeometry.ts`. What stays here
 * is what only this panel knows: where its width preference is stored, and how
 * long it takes to leave.
 */

export const THREAD_PANEL_WIDTH_STORAGE_KEY = 'nessie.threadPanelWidth'

// How long the panel takes to leave. The route change is held until the end so
// the panel keeps rendering its own thread on the way out — its queries are
// keyed on the open root, so navigating first would empty it mid-animation.
// `styles.css` `.thread-panel` carries the matching duration; change both.
export const THREAD_PANEL_CLOSE_MS = 220
