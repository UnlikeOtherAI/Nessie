import { useEffect } from 'react'

import { useAttentionSummary } from '../facades/alerts/hooks'
import { useChannels } from '../facades/channels/hooks'
import { setDesktopBadgeCount } from '../facades/notifications/desktop-native-notification'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import type { SurfaceSection } from '../navigation/page-types'
import { useFocusMode } from './FocusModeProvider'

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (message: string) => void }
}

type BadgingNavigator = Navigator & {
  clearAppBadge?: () => Promise<void>
  setAppBadge?: (count?: number) => Promise<void>
}

// Badges are keyed by the surface registry's section names, the same
// vocabulary `nessie:screen` posts (docs/navigation/overview.md §9/§10), so the shell
// reads one section language rather than a per-message one. A section the
// admin does not count is simply absent, and the shell reads it as 0.
export const attentionBadgeCounts = (
  channels: { unreadCount: number }[],
  attention: { assignedWork: { total: number }; knowledge: { total: number } } | undefined,
): { badges: Partial<Record<SurfaceSection, number>>; total: number } => {
  const channelCount = channels.reduce((total, channel) => total + channel.unreadCount, 0)
  const assignedWork = attention?.assignedWork.total ?? 0
  const knowledge = attention?.knowledge.total ?? 0
  return {
    badges: { channels: channelCount, knowledge, projects: assignedWork },
    total: channelCount + assignedWork + knowledge,
  }
}

const setBrowserBadgeCount = (total: number): void => {
  if (typeof navigator === 'undefined') return
  const browser = navigator as BadgingNavigator
  if (total > 0 && typeof browser.setAppBadge === 'function') {
    void browser.setAppBadge(total).catch(() => undefined)
  } else if (total === 0 && typeof browser.clearAppBadge === 'function') {
    void browser.clearAppBadge().catch(() => undefined)
  }
}

// Projects and Knowledge do not own another unread store. This presenter
// combines the existing channel records with the server-owned alert summary and
// projects the result into the native shell's tab/icon badges.
export const AttentionDisplayManager = () => {
  const { focusModeEnabled } = useFocusMode()
  const { data: channels = [] } = useChannels()
  const { data: attention } = useAttentionSummary()

  useEffect(() => {
    const counts = focusModeEnabled
      ? { badges: { channels: 0, knowledge: 0, projects: 0 }, total: 0 }
      : attentionBadgeCounts(channels, attention)
    if (isReactNativeWebView()) {
      ;(window as NativeShellWindow).ReactNativeWebView?.postMessage(JSON.stringify({
        badges: counts.badges,
        type: 'nessie:attention',
      }))
      return
    }
    if (isDesktopApp()) setDesktopBadgeCount(counts.total)
    else setBrowserBadgeCount(counts.total)
  }, [attention, channels, focusModeEnabled])

  return null
}
