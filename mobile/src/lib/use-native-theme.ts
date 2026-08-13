import { useState } from 'react'
import type { NativeShellMessage } from './native-shell-message'
import { DEFAULT_BG, parseRgb, isDark } from './webview-inject'
import { statusBarStyleForScheme } from './status-bar'

const DEFAULT_ACTIVE_TINT = '#7c3aed'
const DEFAULT_STRONG_ACTIVE_TINT = '#5b21b6'
const DEFAULT_INACTIVE_TINT = '#8a8f98'
const DEFAULT_IPAD_CHROME_SURFACE = '#222629'
const DEFAULT_PHONE_HEADER_SURFACE = '#2b2018'
const DEFAULT_PHONE_HEADER_TEXT = '#fffdf8'
const DEFAULT_PHONE_TEXT = '#2b2018'
const DEFAULT_PHONE_TEXT_MUTED = '#74665b'

export type NativeTheme = {
  accent: string
  inactive: string
  ipadChromeSurface: string
  phoneHeaderSurface: string
  phoneHeaderText: string
  phoneOnAccent: string
  phoneText: string
  phoneTextMuted: string
  strongAccent: string
  dark: boolean
  // The page background behind the WebView (matches during load/overscroll).
  bg: string
  statusBarStyle: 'light' | 'dark'
  // Feed a parsed admin message. Returns true when the message was consumed.
  applyMessage: (msg: NativeShellMessage) => boolean
}

// All theme/bg values the admin streams across the bridge live in one place so
// App.tsx renders chrome from a single snapshot instead of a dozen setters.
export const useNativeTheme = (): NativeTheme => {
  const [bg, setBg] = useState(DEFAULT_BG)
  const [statusBarStyle, setStatusBarStyle] = useState<'light' | 'dark'>('light')
  const [accent, setAccent] = useState(DEFAULT_ACTIVE_TINT)
  const [strongAccent, setStrongAccent] = useState(DEFAULT_STRONG_ACTIVE_TINT)
  const [inactive, setInactive] = useState(DEFAULT_INACTIVE_TINT)
  const [ipadChromeSurface, setIpadChromeSurface] = useState(DEFAULT_IPAD_CHROME_SURFACE)
  const [phoneHeaderSurface, setPhoneHeaderSurface] = useState(DEFAULT_PHONE_HEADER_SURFACE)
  const [phoneHeaderText, setPhoneHeaderText] = useState(DEFAULT_PHONE_HEADER_TEXT)
  const [phoneText, setPhoneText] = useState(DEFAULT_PHONE_TEXT)
  const [phoneTextMuted, setPhoneTextMuted] = useState(DEFAULT_PHONE_TEXT_MUTED)
  const [phoneOnAccent, setPhoneOnAccent] = useState(DEFAULT_PHONE_HEADER_TEXT)

  const applyMessage = (msg: NativeShellMessage): boolean => {
    if (msg.type === 'bg' && typeof msg.color === 'string') {
      const rgb = parseRgb(msg.color)
      if (rgb && rgb[3] !== 0) setBg(msg.color)
      return true
    }
    if (msg.type === 'theme') {
      if (typeof msg.accent === 'string' && msg.accent) setAccent(msg.accent)
      if (typeof msg.accentStrong === 'string' && msg.accentStrong) setStrongAccent(msg.accentStrong)
      if (typeof msg.inactive === 'string' && msg.inactive) setInactive(msg.inactive)
      if (typeof msg.surface === 'string' && msg.surface) setIpadChromeSurface(msg.surface)
      if (typeof msg.headerSurface === 'string' && msg.headerSurface) setPhoneHeaderSurface(msg.headerSurface)
      if (typeof msg.headerText === 'string' && msg.headerText) setPhoneHeaderText(msg.headerText)
      if (typeof msg.text === 'string' && msg.text) setPhoneText(msg.text)
      if (typeof msg.textMuted === 'string' && msg.textMuted) setPhoneTextMuted(msg.textMuted)
      if (typeof msg.onAccent === 'string' && msg.onAccent) setPhoneOnAccent(msg.onAccent)
      const nextStatusBarStyle = statusBarStyleForScheme(msg.scheme)
      if (nextStatusBarStyle) setStatusBarStyle(nextStatusBarStyle)
      return true
    }
    return false
  }

  return {
    accent,
    inactive,
    ipadChromeSurface,
    phoneHeaderSurface,
    phoneHeaderText,
    phoneOnAccent,
    phoneText,
    phoneTextMuted,
    strongAccent,
    dark: isDark(bg),
    bg,
    statusBarStyle,
    applyMessage,
  }
}
