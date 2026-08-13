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

export const IPAD_NATIVE_CHROME_HEIGHT = 42
export const IPAD_NATIVE_CHROME_BOTTOM_CLEARANCE = 12
export const IPAD_WINDOWED_CHROME_TOP = 12
export const IPAD_NATIVE_WORKSPACE_MAX_WIDTH = 220
export const IPAD_NATIVE_WORKSPACE_COLLAPSED_WIDTH = 68
export const IPAD_NATIVE_CHROME_GAP = 12
export const IPAD_NATIVE_TRAILING_ACCOUNT_WIDTH = 42
export const IPAD_NATIVE_FULL_TOP_CHROME_WIDTH_ESTIMATE = 574
export const IPAD_NATIVE_COMPACT_TOP_CHROME_WIDTH_ESTIMATE = 409

export type IpadTopChromeMode = 'compact' | 'full'

export type IpadTopChromeLayout = {
  controlsLeft: number
  mode: IpadTopChromeMode
  workspaceWidth: number | null
}

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

const getCentredControlsLeft = (screenWidth: number, controlsWidth: number): number =>
  (screenWidth - controlsWidth) / 2

const fitsTrailingEdge = (left: number, width: number, trailingEdge: number): boolean =>
  left + width <= trailingEdge

// The workspace owns the leading edge, while all navigation controls are one
// visual group. Preserve both by moving that group trailing before reducing it.
export const getIpadTopChromeLayout = ({
  compactControlsWidth,
  fullControlsWidth,
  hasWorkspace,
  insetLeft,
  insetRight,
  screenWidth,
  trailingReservedWidth,
}: {
  compactControlsWidth: number
  fullControlsWidth: number
  hasWorkspace: boolean
  insetLeft: number
  insetRight: number
  screenWidth: number
  trailingReservedWidth: number
}): IpadTopChromeLayout => {
  const leadingEdge = insetLeft + IPAD_NATIVE_CHROME_GAP
  const trailingEdge = screenWidth - insetRight - IPAD_NATIVE_CHROME_GAP - trailingReservedWidth
  const workspaceRight = leadingEdge + IPAD_NATIVE_WORKSPACE_MAX_WIDTH + IPAD_NATIVE_CHROME_GAP
  const arrangeWithWorkspace = (controlsWidth: number): number => Math.max(
    getCentredControlsLeft(screenWidth, controlsWidth),
    workspaceRight,
  )

  if (!hasWorkspace) {
    const controlsLeft = Math.max(leadingEdge, getCentredControlsLeft(screenWidth, fullControlsWidth))
    if (fitsTrailingEdge(controlsLeft, fullControlsWidth, trailingEdge)) {
      return { controlsLeft, mode: 'full', workspaceWidth: null }
    }
    return {
      controlsLeft: Math.max(leadingEdge, getCentredControlsLeft(screenWidth, compactControlsWidth)),
      mode: 'compact',
      workspaceWidth: null,
    }
  }

  const fullControlsLeft = arrangeWithWorkspace(fullControlsWidth)
  if (fitsTrailingEdge(fullControlsLeft, fullControlsWidth, trailingEdge)) {
    return {
      controlsLeft: fullControlsLeft,
      mode: 'full',
      workspaceWidth: IPAD_NATIVE_WORKSPACE_MAX_WIDTH,
    }
  }

  const compactControlsLeft = arrangeWithWorkspace(compactControlsWidth)
  if (fitsTrailingEdge(compactControlsLeft, compactControlsWidth, trailingEdge)) {
    return {
      controlsLeft: compactControlsLeft,
      mode: 'compact',
      workspaceWidth: IPAD_NATIVE_WORKSPACE_MAX_WIDTH,
    }
  }

  const availableWorkspaceWidth = trailingEdge - leadingEdge - IPAD_NATIVE_CHROME_GAP - compactControlsWidth
  if (availableWorkspaceWidth >= IPAD_NATIVE_WORKSPACE_COLLAPSED_WIDTH) {
    return {
      controlsLeft: leadingEdge + availableWorkspaceWidth + IPAD_NATIVE_CHROME_GAP,
      mode: 'compact',
      workspaceWidth: Math.min(availableWorkspaceWidth, IPAD_NATIVE_WORKSPACE_MAX_WIDTH),
    }
  }

  const centredCompactLeft = getCentredControlsLeft(screenWidth, compactControlsWidth)
  return {
    controlsLeft: Math.max(leadingEdge, centredCompactLeft),
    mode: 'compact',
    workspaceWidth: null,
  }
}
