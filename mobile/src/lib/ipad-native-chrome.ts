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
export const IPAD_NATIVE_ICON_TOP_CHROME_WIDTH_ESTIMATE = 198
export const IPAD_WINDOWED_LEADING_CONTROLS_CLEARANCE = 80

export type IpadTopChromeMode = 'compact' | 'full' | 'icons'

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

export const isIpadWindowed = ({
  screenHeight,
  screenWidth,
  windowHeight,
  windowWidth,
}: {
  screenHeight: number
  screenWidth: number
  windowHeight: number
  windowWidth: number
}): boolean => (
  Math.abs(screenWidth - windowWidth) > 1 || Math.abs(screenHeight - windowHeight) > 1
)

// A Stage Manager window may still report a top safe-area inset. Its actual
// window bounds are the reliable way to identify the traffic-light title bar.
export const getIpadWindowedLeadingControlsClearance = (windowed: boolean): number => (
  windowed ? IPAD_WINDOWED_LEADING_CONTROLS_CLEARANCE : 0
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

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

const arrangeControls = ({
  controlsWidth,
  leadingEdge,
  screenWidth,
  trailingEdge,
  workspaceWidth,
}: {
  controlsWidth: number
  leadingEdge: number
  screenWidth: number
  trailingEdge: number
  workspaceWidth: number | null
}): number | null => {
  const controlsMinLeft = workspaceWidth === null
    ? leadingEdge
    : leadingEdge + workspaceWidth + IPAD_NATIVE_CHROME_GAP
  const controlsMaxLeft = trailingEdge - controlsWidth
  if (controlsMinLeft > controlsMaxLeft) return null
  return clamp(getCentredControlsLeft(screenWidth, controlsWidth), controlsMinLeft, controlsMaxLeft)
}

// The workspace owns the leading edge, while all navigation controls are one
// visual group. Preserve both by moving that group trailing before reducing it.
export const getIpadTopChromeLayout = ({
  compactControlsWidth,
  fullControlsWidth,
  hasWorkspace,
  iconControlsWidth,
  insetLeft,
  insetRight,
  leadingReservedWidth,
  screenWidth,
  trailingReservedWidth,
}: {
  compactControlsWidth: number
  fullControlsWidth: number
  hasWorkspace: boolean
  iconControlsWidth: number
  insetLeft: number
  insetRight: number
  leadingReservedWidth: number
  screenWidth: number
  trailingReservedWidth: number
}): IpadTopChromeLayout => {
  const leadingEdge = insetLeft + leadingReservedWidth + IPAD_NATIVE_CHROME_GAP
  const trailingEdge = screenWidth - insetRight - IPAD_NATIVE_CHROME_GAP - trailingReservedWidth

  if (!hasWorkspace) {
    const fullControlsLeft = arrangeControls({
      controlsWidth: fullControlsWidth,
      leadingEdge,
      screenWidth,
      trailingEdge,
      workspaceWidth: null,
    })
    if (fullControlsLeft !== null) {
      return { controlsLeft: fullControlsLeft, mode: 'full', workspaceWidth: null }
    }
    const compactControlsLeft = arrangeControls({
      controlsWidth: compactControlsWidth,
      leadingEdge,
      screenWidth,
      trailingEdge,
      workspaceWidth: null,
    })
    if (compactControlsLeft !== null) {
      return { controlsLeft: compactControlsLeft, mode: 'compact', workspaceWidth: null }
    }
    const iconControlsLeft = arrangeControls({
      controlsWidth: iconControlsWidth,
      leadingEdge,
      screenWidth,
      trailingEdge,
      workspaceWidth: null,
    })
    return {
      controlsLeft: iconControlsLeft ?? leadingEdge,
      mode: 'icons',
      workspaceWidth: null,
    }
  }

  for (const [mode, controlsWidth] of [
    ['full', fullControlsWidth],
    ['compact', compactControlsWidth],
    ['icons', iconControlsWidth],
  ] as const) {
    const availableWorkspaceWidth = Math.min(
      IPAD_NATIVE_WORKSPACE_MAX_WIDTH,
      trailingEdge - leadingEdge - IPAD_NATIVE_CHROME_GAP - controlsWidth,
    )
    if (availableWorkspaceWidth < IPAD_NATIVE_WORKSPACE_COLLAPSED_WIDTH) continue
    const controlsLeft = arrangeControls({
      controlsWidth,
      leadingEdge,
      screenWidth,
      trailingEdge,
      workspaceWidth: availableWorkspaceWidth,
    })
    if (controlsLeft !== null) {
      return { controlsLeft, mode, workspaceWidth: availableWorkspaceWidth }
    }
  }

  for (const [mode, controlsWidth] of [
    ['compact', compactControlsWidth],
    ['icons', iconControlsWidth],
  ] as const) {
    const controlsLeft = arrangeControls({
      controlsWidth,
      leadingEdge,
      screenWidth,
      trailingEdge,
      workspaceWidth: null,
    })
    if (controlsLeft !== null) return { controlsLeft, mode, workspaceWidth: null }
  }

  return { controlsLeft: leadingEdge, mode: 'icons', workspaceWidth: null }
}
