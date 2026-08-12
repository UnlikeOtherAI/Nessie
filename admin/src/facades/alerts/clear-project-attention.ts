import { useEffect, useRef } from 'react'

import { useAlerts, useMarkAlertsRead } from './hooks'

/** Marks only alert IDs already rendered for one loaded project surface. */
export const useClearProjectAttention = (
  projectId: string,
  kind: 'task_assigned' | 'knowledge_published',
  surfaceLoaded: boolean,
): void => {
  const alerts = useAlerts({ limit: 200, unreadOnly: true })
  const markRead = useMarkAlertsRead()
  const clearedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!surfaceLoaded || !alerts.data || markRead.isPending) return
    const ids = alerts.data.alerts
      .filter((alert) => alert.kind === kind && alert.projectId === projectId)
      .map((alert) => alert.id)
    const key = ids.join(',')
    if (ids.length === 0 || clearedKey.current === key) return
    clearedKey.current = key
    void markRead.mutateAsync({ ids }).catch(() => {
      clearedKey.current = null
    })
  }, [alerts.data, kind, markRead, projectId, surfaceLoaded])
}
