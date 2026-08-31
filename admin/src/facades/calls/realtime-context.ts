import { createContext, useContext } from 'react'
import type { CallInviteUpdatedEvent, CallUpdatedEvent } from '@nessie/schemas'

type CallRealtimeState = {
  inviteUpdates: Map<string, CallInviteUpdatedEvent>
  updates: Map<string, CallUpdatedEvent>
}

const emptyCallRealtimeState: CallRealtimeState = {
  inviteUpdates: new Map(),
  updates: new Map(),
}

export const CallRealtimeContext = createContext<CallRealtimeState>(emptyCallRealtimeState)

export const useCallRealtime = (): CallRealtimeState => useContext(CallRealtimeContext)
