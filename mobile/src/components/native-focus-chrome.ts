import { mixColor } from '../lib/chrome-transition'
import type { NativeShellPresentation } from './native-shell-presentation'

/**
 * Focus mode's navigation palette, for a page that does not publish its own.
 *
 * The admin paints focus as charcoal navigation framing a paper-white work
 * surface. A current admin publishes that palette itself: its
 * `.native-chrome-palette` element sits in the `.focus-mode > .admin-topbar`
 * rule, so its `theme` message already carries focus colours and says so with
 * `chromeSource: 'page'` (docs/navigation/native-shell.md, "theme and bg").
 * These constants are only the fallback for an admin predating that, whose
 * document root never carried focus colours to read back.
 *
 * Keep these in step with that `.focus-mode > .admin-topbar` block.
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
  presentation.nativeAccount.focusModeEnabled && !presentation.pageOwnsChrome
    ? { ...presentation, ...NATIVE_FOCUS_CHROME }
    : presentation

/** The chrome colours focus swaps, and the only ones that animate. */
export const NATIVE_CHROME_KEYS = [
  'accent',
  'chromeSurface',
  'inactive',
  'phoneHeaderSurface',
  'phoneHeaderText',
  'phoneText',
  'phoneTextMuted',
  'strongAccent',
] as const

export type NativeChromeColors = Pick<
  NativeShellPresentation,
  (typeof NATIVE_CHROME_KEYS)[number]
>

export const pickNativeChrome = (
  presentation: NativeShellPresentation,
): NativeChromeColors =>
  Object.fromEntries(
    NATIVE_CHROME_KEYS.map((key) => [key, presentation[key]]),
  ) as NativeChromeColors

export const nativeChromeKey = (chrome: NativeChromeColors): string =>
  NATIVE_CHROME_KEYS.map((key) => chrome[key]).join('|')

/** Every chrome colour, one step along the transition. */
export const blendNativeChrome = (
  from: NativeChromeColors,
  to: NativeChromeColors,
  progress: number,
): NativeChromeColors =>
  Object.fromEntries(
    NATIVE_CHROME_KEYS.map((key) => [key, mixColor(from[key], to[key], progress)]),
  ) as NativeChromeColors
