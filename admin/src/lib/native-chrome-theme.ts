import type { NativeShellInfo } from './native-shell'

/**
 * The palette the native shell draws its own chrome with, read off the page
 * (docs/navigation/native-shell.md, "`theme` and `bg`").
 *
 * The native shell hides the page's top bar and rail and draws its own, so the
 * colours must reach it over the bridge. They are read from an empty element
 * rendered inside `.admin-frame` with the class below: `styles.css` lists that
 * element in every rule that gives the chrome its own palette (a theme's chrome
 * scope, focus mode), so a theme whose chrome differs from its work surface
 * reaches the native header by CSS alone. Where no rule re-scopes the chrome,
 * the element inherits the root tokens, which is the palette the shell read
 * before the page published one.
 *
 * Pure, so the mapping is testable without a WebView.
 */

export const NATIVE_CHROME_PALETTE_CLASS = 'native-chrome-palette'
export const NATIVE_CHROME_PALETTE_SELECTOR = `.admin-frame > .${NATIVE_CHROME_PALETTE_CLASS}`

type PaletteStyle = {
  colorScheme?: string
  getPropertyValue: (name: string) => string
}

/**
 * The shell's existing `theme` message, so installed builds accept it.
 * `chromeSource: 'page'` tells a build that knows it that the page has already
 * resolved focus mode, so the shell must not apply its own focus palette.
 */
export type NativeChromeThemeMessage = {
  accent: string
  accentStrong: string
  chromeSource?: 'page'
  headerSurface: string
  headerText: string
  inactive: string
  onAccent: string
  scheme: string
  surface: string
  text: string
  textMuted: string
  type: 'theme'
}

const token = (style: PaletteStyle, name: string): string => style.getPropertyValue(name).trim()

/**
 * `fromPage: false` is the hand-back when the shell unmounts: the document's
 * own palette, without the marker, so the shell treats it as a root read again.
 */
export const readNativeChromeTheme = (
  palette: PaletteStyle,
  { fromPage = true }: { fromPage?: boolean } = {},
): NativeChromeThemeMessage => {
  const message: NativeChromeThemeMessage = {
    accent: token(palette, '--accent'),
    accentStrong: token(palette, '--accent-strong'),
    headerSurface: token(palette, '--rail'),
    headerText: token(palette, '--tx'),
    inactive: token(palette, '--tx3'),
    onAccent: token(palette, '--on-accent'),
    scheme: palette.colorScheme ?? '',
    surface: token(palette, '--panel'),
    text: token(palette, '--tx'),
    textMuted: token(palette, '--tx2'),
    type: 'theme',
  }
  return fromPage ? { ...message, chromeSource: 'page' } : message
}

export const isIosPhoneShell = (info: NativeShellInfo | null): boolean =>
  info?.platform === 'ios' && (info.formFactor === 'phone' || info.formFactor === 'large-phone-landscape')

/**
 * The colour behind the WebView (the iPad status strip, overscroll, load).
 * Focus keeps the work surface there, as the shell always has. Otherwise it is
 * the chrome's `--rail` (the token the page body is painted with), or the
 * chrome's `--main` on an iPhone, where the injected CSS paints the body with
 * `--main` instead. These are the chrome's values, not the body's: under a
 * theme with its own chrome scope the body's are the work surface, and the
 * backdrop belongs with the native chrome drawn over it.
 */
export const readNativeBackdrop = ({
  focusSurface,
  iosPhone,
  palette,
}: {
  focusSurface: string | null
  iosPhone: boolean
  palette: PaletteStyle
}): string => focusSurface ?? token(palette, iosPhone ? '--main' : '--rail')

export const isTransparentColour = (colour: string): boolean => {
  if (!colour || colour === 'transparent') return true
  const parts = colour.replace(/[^0-9.,]/g, '').split(',')
  return parts.length >= 4 && Number.parseFloat(parts[3] ?? '1') === 0
}
