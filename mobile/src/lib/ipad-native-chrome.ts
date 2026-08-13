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
export const IPAD_WINDOWED_CHROME_TOP = 12

// A full-screen iPad app owns no pixels above its safe area, so native chrome
// must begin exactly at that edge. A Stage Manager window has no top safe-area
// inset; its controls belong in the window title bar instead.
export const getIpadChromeTop = (safeAreaTop: number): number => (
  safeAreaTop > 0 ? safeAreaTop : IPAD_WINDOWED_CHROME_TOP
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
