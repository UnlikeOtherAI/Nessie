import { useEffect } from 'react'

import { useAttentionSummary } from '../facades/alerts/hooks'
import { useChannels } from '../facades/channels/hooks'
import { isReactNativeWebView } from '../lib/mobile-shell'

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (message: string) => void }
}

// Projects and Knowledge do not own another unread store. This presenter
// combines the existing channel records with the server-owned alert summary and
// projects the result into the native shell's tab/icon badges.
export const AttentionDisplayManager = () => {
  const { data: channels = [] } = useChannels()
  const { data: attention } = useAttentionSummary()

  useEffect(() => {
    if (!isReactNativeWebView()) return
    const channelCount = channels.reduce((total, channel) => total + channel.unreadCount, 0)
    const assignedWork = attention?.assignedWork.total ?? 0
    const knowledge = attention?.knowledge.total ?? 0
    ;(window as NativeShellWindow).ReactNativeWebView?.postMessage(JSON.stringify({
      assignedWork,
      channels: channelCount,
      knowledge,
      total: channelCount + assignedWork + knowledge,
      type: 'nessie:attention',
    }))
  }, [attention, channels])

  return null
}
