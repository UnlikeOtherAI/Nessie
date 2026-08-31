import { useEffect, useRef, useState } from 'react'
import {
  useActiveCall,
  useCancelCall,
  useEndCall,
  useStartCall,
} from '../../facades/calls/hooks'
import { startCallFailureCode as getStartCallFailureCode } from '../../facades/calls/call-presentation'
import type { CallRecord, ChannelRecord } from '../../lib/api-client'

interface UseChannelCallParams {
  activeChannel: ChannelRecord | null
  callEligible: boolean
}

interface UseChannelCallResult {
  activeCall: CallRecord | null | undefined
  callActionError: unknown
  callActionPending: boolean
  callStarting: boolean
  callerDialogCall: CallRecord | null
  onCallButton: () => void
  onCloseCallerDialog: () => void
  onCloseStartCallFailure: () => void
  onFinishCall: () => void
  startCallFailureCode: string | undefined
}

/**
 * Owns the channel caller path: start a link call, retain the caller dialog
 * for that exact call, and recover a typed start refusal. Incoming-call UI is
 * deliberately app-wide work for slice 4b, not part of this channel seam.
 */
export const useChannelCall = ({
  activeChannel,
  callEligible,
}: UseChannelCallParams): UseChannelCallResult => {
  const activeCallQuery = useActiveCall(activeChannel?.id)
  const activeCall = activeCallQuery.data
  const cancelCall = useCancelCall()
  const endCall = useEndCall()
  const startCall = useStartCall()
  const { reset: resetStartCall } = startCall
  const [callerDialogCallId, setCallerDialogCallId] = useState<string | null>(null)
  const activeChannelIdRef = useRef(activeChannel?.id)
  activeChannelIdRef.current = activeChannel?.id

  useEffect(() => {
    setCallerDialogCallId(null)
    resetStartCall()
  }, [activeChannel?.id, resetStartCall])

  const callerDialogCall =
    callerDialogCallId && activeCall?.id === callerDialogCallId ? activeCall : null

  const onCallButton = () => {
    if (!callEligible || !activeChannel || startCall.isPending) return

    if (activeCall) {
      setCallerDialogCallId(activeCall.id)
      return
    }

    const channelId = activeChannel.id
    startCall.mutate(channelId, {
      onError: () => {
        void activeCallQuery.refetch()
      },
      onSuccess: (call) => {
        if (activeChannelIdRef.current === channelId) {
          setCallerDialogCallId(call.id)
        }
      },
    })
  }

  const onCloseCallerDialog = () => setCallerDialogCallId(null)
  const onCloseStartCallFailure = () => resetStartCall()

  const onFinishCall = () => {
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
    onCloseStartCallFailure,
    onFinishCall,
    startCallFailureCode: getStartCallFailureCode(startCall.error),
  }
}
