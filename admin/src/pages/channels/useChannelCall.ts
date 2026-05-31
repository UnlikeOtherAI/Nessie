import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useActiveCall,
  useJoinCall,
  useLeaveCall,
  useStartCall,
} from '../../facades/calls/hooks'
import type { CallParticipantRecord, CallRecord, ChannelRecord } from '../../lib/api-client'

interface UseChannelCallParams {
  activeChannel: ChannelRecord | null
  currentUserId: string | undefined
  callEligible: boolean
}

interface UseChannelCallResult {
  activeCall: CallRecord | null | undefined
  activeParticipants: CallParticipantRecord[]
  isInCall: boolean
  showCallOverlay: boolean
  setShowCallOverlay: React.Dispatch<React.SetStateAction<boolean>>
  onCallButton: () => void
  onBannerJoin: () => void
  onOverlayLeave: () => void
}

export const useChannelCall = ({
  activeChannel,
  currentUserId,
  callEligible,
}: UseChannelCallParams): UseChannelCallResult => {
  const { data: activeCall } = useActiveCall(activeChannel?.id)
  const startCall = useStartCall()
  const joinCall = useJoinCall()
  const leaveCall = useLeaveCall()
  const [showCallOverlay, setShowCallOverlay] = useState(false)

  const activeParticipants = useMemo(
    () => (activeCall?.participants ?? []).filter((p) => !p.leftAt),
    [activeCall],
  )
  const isInCall = useMemo(
    () => activeParticipants.some((p) => p.userId === currentUserId),
    [activeParticipants, currentUserId],
  )

  // Auto-open the overlay when the user joins or starts a call on the current channel.
  // Track channelId alongside isInCall so that navigating to a channel where the user
  // is already a participant does not spuriously trigger the overlay.
  const prevCallStateRef = useRef<{ channelId: string | undefined; isInCall: boolean }>({
    channelId: activeChannel?.id,
    isInCall: false,
  })
  useEffect(() => {
    const prev = prevCallStateRef.current
    const channelChanged = prev.channelId !== activeChannel?.id
    if (!channelChanged && isInCall && !prev.isInCall) {
      setShowCallOverlay(true)
    }
    prevCallStateRef.current = { channelId: activeChannel?.id, isInCall }
  }, [isInCall, activeChannel?.id])

  // Reset the call overlay when switching channels.
  useEffect(() => {
    setShowCallOverlay(false)
  }, [activeChannel?.id])

  const onCallButton = () => {
    if (!callEligible || !activeChannel) return
    if (!activeCall) {
      startCall.mutate(activeChannel.id)
    } else if (!isInCall) {
      joinCall.mutate(activeCall.id)
    } else {
      setShowCallOverlay((v) => !v)
    }
  }

  const onBannerJoin = () => {
    if (activeCall) {
      joinCall.mutate(activeCall.id)
    }
  }

  const onOverlayLeave = () => {
    if (activeCall) {
      leaveCall.mutate(activeCall.id)
    }
    setShowCallOverlay(false)
  }

  return {
    activeCall,
    activeParticipants,
    isInCall,
    showCallOverlay,
    setShowCallOverlay,
    onCallButton,
    onBannerJoin,
    onOverlayLeave,
  }
}
