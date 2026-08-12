import { useEffect, useRef, useState } from 'react'

import { useAttentionSummary, useMarkAlertsRead } from './hooks'

/**
 * Marks the durable attention that existed when a Board or Docs surface finished
 * loading. The API snapshots the matching alert IDs before it writes, so an
 * alert committed while that request is in flight remains unread. A server
 * version makes the clear run again for new attention while this surface stays open.
 */
export const useClearProjectAttention = (
  projectId: string,
  kind: 'task_assigned' | 'knowledge_published',
  surfaceLoaded: boolean,
): void => {
  const attention = useAttentionSummary()
  const { mutateAsync } = useMarkAlertsRead()
  const [clearing, setClearing] = useState(false)
  const [lastClearedVersion, setLastClearedVersion] = useState<string | null>(null)
  const retryDelayMs = useRef(1_000)
  const retryScheduled = useRef(false)
  const retryTimer = useRef<number | null>(null)
  const [retryGeneration, setRetryGeneration] = useState(0)

  const section = kind === 'task_assigned' ? attention.data?.assignedWork : attention.data?.knowledge
  const version = section?.versions?.[projectId]

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
  }, [])

  useEffect(() => {
    if (
      !surfaceLoaded
      || !version
      || clearing
      || retryScheduled.current
      || lastClearedVersion === version
    ) return
    setClearing(true)

    void mutateAsync({ surface: { kind, projectId } })
      .then(() => {
        retryDelayMs.current = 1_000
        setLastClearedVersion(version)
      })
      .catch(() => {
        const delay = retryDelayMs.current
        retryDelayMs.current = Math.min(delay * 2, 30_000)
        retryScheduled.current = true
        retryTimer.current = window.setTimeout(() => {
          retryScheduled.current = false
          retryTimer.current = null
          setRetryGeneration((generation) => generation + 1)
        }, delay)
      })
      .finally(() => setClearing(false))
  }, [clearing, kind, lastClearedVersion, mutateAsync, projectId, retryGeneration, surfaceLoaded, version])
}
