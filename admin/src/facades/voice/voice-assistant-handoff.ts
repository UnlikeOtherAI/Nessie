import type { VoiceApi } from './voice-api'

/**
 * `pa_send`: handing work to the assistant's ordinary run, mid-call.
 *
 * The request is posted as a normal message in the DM — the same route the
 * composer uses — so the run it starts is indistinguishable from one the
 * person typed and every existing gate applies. Nothing about the call widens
 * what the assistant may do.
 *
 * The tool answers immediately with "working", because Gemini Live blocks the
 * conversation until a tool responds and a real run can take minutes. The
 * reply is spoken later, as its own turn.
 */

/** How long to wait for a reply before giving up on speaking it. */
const REPLY_TIMEOUT_MS = 5 * 60_000

/** Poll interval. Long enough to be cheap, short enough to feel answered. */
const POLL_INTERVAL_MS = 2_500

export type AssistantHandoff = {
  dispatch: (
    text: string,
    /** Gemini's own id for the call, which is the idempotency key. */
    providerCallId: string,
  ) => Promise<{ status: string; detail: string }>
  stop: () => void
}

export const createAssistantHandoff = (deps: {
  api: VoiceApi
  /** Speaks a delivered reply through the model, in its own voice. */
  speak: (text: string) => void
  voiceSessionId: string
}): AssistantHandoff => {
  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        resolve()
      }, ms)
      timers.add(timer)
    })

  /**
   * Waits for the assistant's reply and speaks it.
   *
   * Polling a viewer-entitled read rather than watching the thread stream: a
   * run that consumed a privileged source has its live lane cut structurally,
   * so the stream can never deliver, while the read answers correctly either
   * way — with the reply if this viewer may see it, and without it if not.
   */
  const awaitReply = async (afterMessageId: string): Promise<void> => {
    const deadline = Date.now() + REPLY_TIMEOUT_MS
    while (!stopped && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      if (stopped) return
      try {
        const replies = await deps.api.repliesAfter(deps.voiceSessionId, afterMessageId)
        const reply = replies.find((message) => message.text.trim().length > 0)
        if (reply) {
          if (!stopped) deps.speak(reply.text)
          return
        }
      } catch {
        // A transient read failure is not the end of the wait; the loop's own
        // deadline is what bounds it.
      }
    }
  }

  return {
    dispatch: async (text, providerCallId) => {
      try {
        const created = await deps.api.sendToAssistant(deps.voiceSessionId, text, providerCallId)
        void awaitReply(created.messageId)
        return {
          status: 'working',
          detail:
            'Started. Tell the person you are on it and keep talking — the answer will arrive as its own turn.',
        }
      } catch {
        return {
          status: 'failed',
          detail: 'That could not be handed over. Tell the person it did not go through.',
        }
      }
    },
    stop: () => {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}
