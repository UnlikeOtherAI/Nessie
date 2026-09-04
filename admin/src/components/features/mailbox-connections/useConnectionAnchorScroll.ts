import { useEffect } from 'react'

import { connectionAnchorId } from '../../../lib/connection-anchor'
import { parseHashAnchor, useConsumedHashIntent } from '../../../navigation/intent'

const parseConnectionAnchor = parseHashAnchor('connection')

/**
 * The Settings-side half of opening an existing account. Navigation carries a
 * structural connection id in a one-shot fragment; this owner waits for its
 * own query to render before revealing the matching card.
 */
export const useConnectionAnchorScroll = (ready: boolean): void => {
  const requestedConnection = useConsumedHashIntent('connection', parseConnectionAnchor)

  useEffect(() => {
    if (!ready || !requestedConnection.value) return
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(connectionAnchorId(requestedConnection.value as string))
        ?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ready, requestedConnection.serial, requestedConnection.value])
}
