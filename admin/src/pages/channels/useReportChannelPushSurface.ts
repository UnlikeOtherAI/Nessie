import { useEffect } from 'react'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
import type { Location } from 'react-router-dom'
import type { ChannelRecord } from '../../lib/api-client'
import { reportPushSurface } from '../../lib/push-surface'

type Args = {
  activeChannel: ChannelRecord | null
  activeThreadId: string | null | undefined
  location: Location
  openRootMessageId: string | null
  visibleActiveTab: string
}

export const useReportChannelPushSurface = ({
  activeChannel,
  activeThreadId,
  location,
  openRootMessageId,
  visibleActiveTab,
}: Args): void => {
  useEffect(() => {
    if (visibleActiveTab !== 'messages' || !activeChannel || !activeThreadId) {
      reportPushSurface(null, location)
      return undefined
    }
    reportPushSurface({
      channelId: parseChannelId(activeChannel.id),
      kind: 'channel',
      rootMessageId: openRootMessageId,
      threadId: parseThreadId(activeThreadId),
    }, location)
    return () => reportPushSurface(null, location)
  }, [activeChannel, activeThreadId, location, openRootMessageId, visibleActiveTab])
}
