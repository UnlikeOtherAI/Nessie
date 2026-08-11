import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PendingStreamMessage } from '../../../facades/threads/thinking'
import type { ThreadMessageRecord } from '../../../lib/api-client'
import {
  LIVENESS_HINT_TIMEOUT_MS,
  readLivenessSignature,
  shouldShowLivenessHint,
  type LivenessSignature,
} from './liveness-hint'

interface UseAgentLivenessHintParams {
  // Structural fact only: this surface has at least one agent that *could* pick
  // the message up. Never a prediction that one will — that judgement belongs
  // to the engagement orchestrator's model, and it may decline.
  hasRespondingAgent: boolean
  meUserId: string
  // The messages this surface renders (the channel thread, or one reply
  // thread's root plus its replies).
  messages: ThreadMessageRecord[]
  // The live runs whose thinking bubble this surface renders. As soon as one
  // exists the bubble replaces the hint.
  pendingMessages: PendingStreamMessage[]
  // Drops a stale hint when the surface switches to another thread or root.
  surfaceKey: string | undefined
}

interface UseAgentLivenessHintResult {
  // Call when the viewer posts from this surface.
  markSent: () => void
  visible: boolean
}

/**
 * Client-local, optimistic, anonymous "something is happening" state for one
 * message surface. Cleared on the first of: a thinking bubble appearing for any
 * run this surface renders, a message from anyone else, an agent reaction, or
 * `LIVENESS_HINT_TIMEOUT_MS`.
 */
export const useAgentLivenessHint = ({
  hasRespondingAgent,
  meUserId,
  messages,
  pendingMessages,
  surfaceKey,
}: UseAgentLivenessHintParams): UseAgentLivenessHintResult => {
  const [baseline, setBaseline] = useState<LivenessSignature | null>(null)
  const signature = useMemo(
    () => readLivenessSignature(messages, meUserId),
    [meUserId, messages],
  )
  const visible = shouldShowLivenessHint({
    baseline,
    current: signature,
    hasPendingRun: pendingMessages.length > 0,
  })

  useEffect(() => {
    setBaseline(null)
  }, [surfaceKey])

  // Silence is a valid outcome — the orchestrator may decline to engage — so the
  // hint expires on its own rather than pulsing until the next navigation.
  useEffect(() => {
    if (!baseline) {
      return
    }
    const timer = setTimeout(() => setBaseline(null), LIVENESS_HINT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [baseline])

  // Render already decided the hint is over; release the state and its timer.
  useEffect(() => {
    if (baseline && !visible) {
      setBaseline(null)
    }
  }, [baseline, visible])

  const markSent = useCallback(() => {
    if (!hasRespondingAgent) {
      return
    }
    setBaseline(signature)
  }, [hasRespondingAgent, signature])

  return { markSent, visible }
}
