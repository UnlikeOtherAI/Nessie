import { useNativeIOSPhoneApp, useNavigationLayout } from '../lib/mobile-shell'
import { useScreenBarLayerKey } from './ScreenBarLayer'
import { useScreenBarPublisher } from './useScreenBar'
import type { ScreenBar } from './screen-bar'

/**
 * For a screen that draws its own header rather than `ScreenHeader`.
 *
 * Seven components do: the conversation-info flow, the reply thread, the two
 * full-screen `fixed inset-0` panels (an agent's screen, a dashboard
 * workspace), a Knowledge pane, the workflow designer and a column-browser
 * column. Each publishes its bar through here and asks whether to draw its own
 * header row, so the iOS shell never ends up with native chrome above a web
 * header saying something else — and, just as bad, never leaves the bar naming
 * the screen *underneath* the one on top.
 *
 * `hidden` is true only inside the iOS phone shell. Every other surface —
 * mobile Safari, the Android app, iPad, desktop — keeps drawing exactly what
 * it drew before.
 *
 * Publication is per stack layer and stacks within a layer, so a full-screen
 * panel over a conversation sits above the conversation's own descriptor and
 * hands it back on close, with no coordination between the two (screen-bar.ts).
 */
export const useNativeBarHeader = (bar: ScreenBar, active = true): { hidden: boolean } => {
  const single = useNavigationLayout() === 'single'
  const layerKey = useScreenBarLayerKey()
  const nativeBar = useNativeIOSPhoneApp() && single
  useScreenBarPublisher(bar, active && nativeBar)
  // A header outside any stack layer has nothing to publish to, so hiding it
  // would remove the only chrome on the screen. Hide only where the native bar
  // is actually being fed.
  return { hidden: nativeBar && active && layerKey !== null }
}
