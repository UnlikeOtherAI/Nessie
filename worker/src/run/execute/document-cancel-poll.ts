import type { PrismaClient } from '@prisma/client'
import type { DocumentStreamRecorder } from './document-stream.js'

const POLL_INTERVAL_MS = 1_000

/**
 * Model's-maximum output for a turn that can compose a document.
 *
 * A document is emitted as tool-call arguments inside a single completion, so
 * the deployment's ordinary per-call cap (2,048 tokens by default) would cut it
 * off mid-sentence. There is deliberately no env knob: the run budget is the
 * spend envelope, and this only lifts the per-call ceiling under it.
 */
export const resolveComposeOutputTokens = (configuredMaxTokens: number): number =>
  Math.max(configuredMaxTokens, 32_768)

type PollInput = {
  documentStream: DocumentStreamRecorder | undefined
  onCancelled: () => void
  prisma: PrismaClient
  runId: string
}

/**
 * Watches for a cancellation while a document is being written.
 *
 * The agentic loop only checks `cancelRequestedAt` between iterations and after
 * tool batches, which for a multi-minute document means Stop appears to do
 * nothing until the whole thing has been written. This polls on its own timer —
 * never inside the provider read loop, where an awaited query would throttle
 * the very stream it is watching — and only touches the database while a
 * session is actually open, so ordinary runs pay nothing.
 */
export const startCancellationPoll = (input: PollInput): { stop: () => void } => {
  let stopped = false
  let checking = false

  const timer = setInterval(() => {
    if (stopped || checking) return
    if (!input.documentStream?.hasOpenSession()) return
    checking = true
    void input.prisma.run
      .findUnique({ select: { cancelRequestedAt: true }, where: { id: input.runId } })
      .then((row) => {
        if (!stopped && row?.cancelRequestedAt) {
          input.onCancelled()
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false
      })
  }, POLL_INTERVAL_MS)
  timer.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
