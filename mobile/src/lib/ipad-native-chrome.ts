import { parseRgb } from './webview-inject'

export type IpadNativeChromeTheme = {
  activeBackgroundColor: string
  activeTintColor: string
  backgroundColor: string
  borderColor: string
  inactiveTintColor: string
  pressedBackgroundColor: string
}

type IpadNativeChromeThemeOptions = {
  activeTintColor: string
  dark: boolean
  inactiveTintColor: string
  surfaceColor: string
}

export const IPAD_NATIVE_TOOLBAR_WIDTH = 153
export const IPAD_NATIVE_CHROME_HEIGHT = 42
export const IPAD_NATIVE_CHROME_BOTTOM_CLEARANCE = 12
export const IPAD_WINDOWED_CHROME_TOP = 12
export const IPAD_NATIVE_WORKSPACE_MAX_WIDTH = 220
export const IPAD_NATIVE_WORKSPACE_MIN_WIDTH = 104
export const IPAD_NATIVE_CHROME_GAP = 12

// A full-screen iPad app owns no pixels above its safe area, so native chrome
// must begin exactly at that edge. A Stage Manager window has no top safe-area
// inset; its controls belong in the window title bar instead.
export const getIpadChromeTop = (safeAreaTop: number): number => (
  safeAreaTop > 0 ? safeAreaTop : IPAD_WINDOWED_CHROME_TOP
)

// Keep the WebView's first row clear of the floating native controls. This is
// separate from the window title-bar offset: both full-screen and Stage Manager
// layouts need the same breathing room beneath the controls.
export const getIpadContentTop = (chromeTop: number): number => (
  chromeTop + IPAD_NATIVE_CHROME_HEIGHT + IPAD_NATIVE_CHROME_BOTTOM_CLEARANCE
)

export const withOpacity = (color: string, opacity: number): string => {
  const rgb = parseRgb(color)
  if (rgb) {
    const [red, green, blue] = rgb
    return `rgba(${red}, ${green}, ${blue}, ${opacity})`
  }
  const hex = color.replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const alpha = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, '0')
    return `#${hex}${alpha}`
  }
  return color
}

export const createIpadNativeChromeTheme = ({
  activeTintColor,
  dark,
  inactiveTintColor,
  surfaceColor,
}: IpadNativeChromeThemeOptions): IpadNativeChromeTheme => ({
  activeBackgroundColor: withOpacity(activeTintColor, dark ? 0.3 : 0.14),
  activeTintColor,
  backgroundColor: withOpacity(surfaceColor, 0.88),
  borderColor: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 23, 42, 0.1)',
  inactiveTintColor,
  pressedBackgroundColor: withOpacity(activeTintColor, dark ? 0.42 : 0.2),
})

export const getIpadToolbarLeft = (
  screenWidth: number,
  tabBarWidth: number,
  insetLeft: number,
): number => Math.max(insetLeft + 12, (screenWidth - tabBarWidth) / 2 - IPAD_NATIVE_TOOLBAR_WIDTH - 12)

// The workspace chip occupies the leading space before browser controls. Hide
// it in a narrow split view rather than letting it cover those controls.
export const getIpadWorkspaceWidth = (toolbarLeft: number, insetLeft: number): number | null => {
  const available = toolbarLeft - insetLeft - IPAD_NATIVE_CHROME_GAP * 2
  return available >= IPAD_NATIVE_WORKSPACE_MIN_WIDTH
    ? Math.min(available, IPAD_NATIVE_WORKSPACE_MAX_WIDTH)
    : null
}
