import { ApiClientError } from '@nessie/client-core'

export type LiveViewRecovery = 'idle' | 'loading' | 'retryable' | 'terminal' | 'denied'

export const recoveryForLiveViewError = (
  error: unknown,
): Extract<LiveViewRecovery, 'denied' | 'terminal' | 'retryable'> => {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) return 'denied'
    if (error.status === 404 || error.status === 410) return 'terminal'
  }
  return 'retryable'
}

export const liveViewStatusLabel = (status: string): string => ({
  allocating: 'Starting', active: 'Live', releasing: 'Closing', released: 'Closed',
  failed: 'Failed', unknown: 'Unknown',
})[status] ?? 'Loading'

export const liveViewRecoveryMessage = (recovery: LiveViewRecovery): string | null => {
  if (recovery === 'denied') {
    return 'You no longer have access to this browser. Ask the agent owner to enable Browser.'
  }
  if (recovery === 'terminal') {
    return 'This browser has closed. Open a new browser from this agent’s conversation.'
  }
  return null
}

/**
 * Browserbase Live View emits this when its own connection drops. The event
 * must belong to the iframe we rendered: the provider origin is shared by
 * more than one potential frame in an application window.
 */
export const isCurrentLiveViewDisconnect = (
  event: Pick<MessageEvent<unknown>, 'data' | 'origin' | 'source'>,
  frameOrigin: string | null,
  frameWindow: Window | null | undefined,
): boolean => {
  if (!frameOrigin || event.origin !== frameOrigin || event.source !== frameWindow) return false
  return event.data === 'browserbase-disconnected'
}
