import { useEffect, useMemo, useState } from 'react'
import {
  useActiveCall,
  useStartCall,
} from '../../facades/calls/hooks'
import type { CallParticipantRecord, CallRecord, ChannelRecord } from '../../lib/api-client'

interface UseChannelCallParams {
  activeChannel: ChannelRecord | null
  callEligible: boolean
}

interface UseChannelCallResult {
  activeCall: CallRecord | null | undefined
  activeParticipants: CallParticipantRecord[]
  showCallOverlay: boolean
  onCallButton: () => void
  onOverlayLeave: () => void
}

export const useChannelCall = ({
  activeChannel,
  callEligible,
}: UseChannelCallParams): UseChannelCallResult => {
  const { data: activeCall } = useActiveCall(activeChannel?.id)
  const startCall = useStartCall()
  const [showCallOverlay, setShowCallOverlay] = useState(false)

  const activeParticipants = useMemo(
    () => (activeCall?.participants ?? []).filter((p) => !p.leftAt),
    [activeCall],
  )
  useEffect(() => {
    setShowCallOverlay(false)
  }, [activeChannel?.id])

  const onCallButton = () => {
    if (!callEligible || !activeChannel) return
    if (!activeCall) {
      startCall.mutate(activeChannel.id)
    } else if (activeCall.roomId) {
      setShowCallOverlay(true)
    }
  }

  const onOverlayLeave = () => {
    setShowCallOverlay(false)
  }

  return {
    activeCall,
    activeParticipants,
    showCallOverlay,
    onCallButton,
    onOverlayLeave,
  }
}
