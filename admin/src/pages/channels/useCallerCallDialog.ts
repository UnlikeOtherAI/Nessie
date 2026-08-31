import { useEffect, useRef, useState } from 'react'
import {
  useActiveCall,
  useCancelCall,
  useEndCall,
  useStartCall,
} from '../../facades/calls/hooks'
import type { CallRecord, ChannelRecord } from '../../lib/api-client'

interface UseCallerCallDialogParams {
  activeChannel: ChannelRecord | null
  callEligible: boolean
}

interface UseCallerCallDialogResult {
  activeCall: CallRecord | null | undefined
  callActionError: unknown
  callActionPending: boolean
  callStarting: boolean
  callerDialogCall: CallRecord | null
  onCallButton: () => void
  onCloseCallerDialog: () => void
  onEndCall: () => void
}

/**
 * Owns the caller's path only: start a channel call, keep its dialog open for
 * that exact call, and cancel or end it through the existing call routes.
 * Incoming calls are a separate, app-wide concern and deliberately do not
 * enter this seam.
 */
export const useCallerCallDialog = ({
  activeChannel,
  callEligible,
}: UseCallerCallDialogParams): UseCallerCallDialogResult => {
  const { data: activeCall } = useActiveCall(activeChannel?.id)
  const cancelCall = useCancelCall()
  const endCall = useEndCall()
  const startCall = useStartCall()
  const [callerDialogCallId, setCallerDialogCallId] = useState<string | null>(null)
  const activeChannelIdRef = useRef(activeChannel?.id)
  activeChannelIdRef.current = activeChannel?.id

  useEffect(() => {
    setCallerDialogCallId(null)
  }, [activeChannel?.id])

  const callerDialogCall =
    callerDialogCallId && activeCall?.id === callerDialogCallId ? activeCall ?? null : null

  const onCallButton = () => {
    if (!callEligible || !activeChannel || startCall.isPending) return

    if (activeCall) {
      setCallerDialogCallId(activeCall.id)
      return
    }

    const channelId = activeChannel.id
    startCall.mutate(channelId, {
      onSuccess: (call) => {
        if (activeChannelIdRef.current === channelId) {
          setCallerDialogCallId(call.id)
        }
      },
    })
  }

  const onCloseCallerDialog = () => setCallerDialogCallId(null)

  const onEndCall = () => {
    if (!activeChannel || !callerDialogCall) return

    if (callerDialogCall.status === 'ringing') {
      cancelCall.mutate(callerDialogCall.id, { onSuccess: onCloseCallerDialog })
      return
    }

    if (callerDialogCall.status === 'active') {
      endCall.mutate(activeChannel.id, { onSuccess: onCloseCallerDialog })
    }
  }

  return {
    activeCall,
    callActionError: cancelCall.error ?? endCall.error,
    callActionPending: cancelCall.isPending || endCall.isPending,
    callStarting: startCall.isPending,
    callerDialogCall,
    onCallButton,
    onCloseCallerDialog,
    onEndCall,
  }
}
