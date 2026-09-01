import { useEffect } from 'react'

import { useAttentionSummary } from '../facades/alerts/hooks'
import { useChannels } from '../facades/channels/hooks'
import { setDesktopBadgeCount } from '../facades/notifications/desktop-native-notification'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { useFocusMode } from './FocusModeProvider'

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (message: string) => void }
}

type BadgingNavigator = Navigator & {
  clearAppBadge?: () => Promise<void>
  setAppBadge?: (count?: number) => Promise<void>
}

export const attentionBadgeCounts = (
  channels: { unreadCount: number }[],
  attention: { assignedWork: { total: number }; knowledge: { total: number } } | undefined,
) => {
  const channelCount = channels.reduce((total, channel) => total + channel.unreadCount, 0)
  const assignedWork = attention?.assignedWork.total ?? 0
  const knowledge = attention?.knowledge.total ?? 0
  return {
    assignedWork,
    channels: channelCount,
    knowledge,
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
      ? { assignedWork: 0, channels: 0, knowledge: 0, total: 0 }
      : attentionBadgeCounts(channels, attention)
    if (isReactNativeWebView()) {
      ;(window as NativeShellWindow).ReactNativeWebView?.postMessage(JSON.stringify({
        ...counts,
        type: 'nessie:attention',
      }))
      return
    }
    if (isDesktopApp()) setDesktopBadgeCount(counts.total)
    else setBrowserBadgeCount(counts.total)
  }, [attention, channels, focusModeEnabled])

  return null
}
