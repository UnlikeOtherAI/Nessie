import type { NativeShellPresentation } from './native-shell-presentation'

/**
 * Focus mode's navigation palette, for the chrome the native shell draws.
 *
 * The admin paints focus as charcoal navigation framing a paper-white work
 * surface, and declares that navigation palette only on the chrome the page
 * itself draws (`admin/src/styles.css`, `.focus-mode > .admin-topbar` and the
 * sidebar rail beside it). A native shell hides both of those, so on a phone
 * the page contains no element carrying these colours to read back over the
 * bridge -- the native header and tab bar have to hold them directly.
 *
 * Keep these in step with that `.focus-mode > .admin-topbar` block; they are
 * the same colours, for the chrome the page is not drawing.
 */
export const NATIVE_FOCUS_CHROME = {
  accent: '#b9b9bc',
  chromeSurface: '#353535',
  inactive: '#aeaeaf',
  phoneHeaderSurface: '#242424',
  phoneHeaderText: '#f1f1f1',
  phoneText: '#f1f1f1',
  phoneTextMuted: '#d4d4d6',
  strongAccent: '#ececee',
} as const

/**
 * Focus swaps only the chrome colours. `background` still comes from the page,
 * so the frame behind the WebView keeps matching the work surface rather than
 * being repainted from here, and the status bar keeps deriving its contrast
 * from whichever backdrop it is actually sitting on.
 */
export const applyNativeFocusChrome = (
  presentation: NativeShellPresentation,
): NativeShellPresentation =>
  presentation.nativeAccount.focusModeEnabled
    ? { ...presentation, ...NATIVE_FOCUS_CHROME }
    : presentation
