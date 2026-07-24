import { useEffect, useRef } from 'react'
import { useMarkThreadRead } from '../../facades/threads/hooks'
import type { ThreadMessageRecord } from '../../lib/api-client'

// Marks the active thread read once its latest message has rendered. Guards
// against duplicate posts per thread: one in-flight marker and one
// acknowledged marker, both reset when the thread changes.
export const useThreadReadMarker = (
  threadId: string | undefined,
  threadMessages: ThreadMessageRecord[],
) => {
  const markThreadRead = useMarkThreadRead()
  const lastReadMarkerRef = useRef<string | null>(null)
  const pendingReadMarkerRef = useRef<string | null>(null)

  useEffect(() => {
    lastReadMarkerRef.current = null
    pendingReadMarkerRef.current = null
  }, [threadId])

  useEffect(() => {
    const latestMessageId = threadMessages.at(-1)?.id
    if (!threadId || !latestMessageId) {
      return
    }

    const marker = `${threadId}:${latestMessageId}`
    if (lastReadMarkerRef.current === marker || pendingReadMarkerRef.current === marker) {
      return
    }

    pendingReadMarkerRef.current = marker
    markThreadRead.mutate(threadId, {
      onError: () => {
        pendingReadMarkerRef.current = null
      },
      onSuccess: () => {
        lastReadMarkerRef.current = marker
        pendingReadMarkerRef.current = null
      },
    })
  }, [threadId, markThreadRead, threadMessages])
}
