import type { PrismaClient, RunThinkingChunkKind } from '@prisma/client'
import { parseRunId } from '@nessie/schemas'
import type { PgRealtimeTransport } from '@nessie/runtime'

// Flush thresholds for coalescing visible reasoning. Provider reasoning arrives
// token-by-token; writing a row + an SSE event per token would be pure spam, so
// deltas are buffered until either enough text has accumulated or the buffer has
// been waiting long enough for the bubble to look live.
export const REASONING_FLUSH_BYTES = 2048
export const REASONING_FLUSH_MS = 250

export type ThinkingRecorder = {
  /** Buffer a visible-reasoning delta; flushed on size or age. */
  appendReasoning: (delta: string) => Promise<void>
  /** Flush pending reasoning, then record one tool line immediately. */
  appendToolLine: (toolName: string, inputSummary: string) => Promise<void>
  /** Final flush. Idempotent, and safe to call from a `finally`. */
  close: () => Promise<void>
}

type RecorderInput = {
  prisma: PrismaClient
  realtimeTransport: Pick<PgRealtimeTransport, 'publishSse'>
  runId: string
  threadId: string
}

/**
 * Per-run thought-process recorder.
 *
 * Every flush writes one durable `RunThinkingChunk` and publishes the same
 * content on the thread's SSE stream carrying the row's id, so a client can
 * merge live events with the REST thought log without duplicating chunks. This
 * *replaces* the previous per-delta `stream.reasoning` publish, which also cuts
 * `thread_stream_events` write volume.
 *
 * Capturing a thought process is never worth failing a run over: every error is
 * swallowed with a `console.warn`.
 */
export const createThinkingRecorder = (input: RecorderInput): ThinkingRecorder => {
  let buffer = ''
  let bufferTimer: NodeJS.Timeout | null = null
  let closed = false
  // Serializes flushes so chunk ids stay in emission order even when a tool line
  // interleaves with a timer-driven reasoning flush.
  let queue: Promise<void> = Promise.resolve()

  const clearBufferTimer = (): void => {
    if (bufferTimer) {
      clearTimeout(bufferTimer)
      bufferTimer = null
    }
  }

  const write = async (kind: RunThinkingChunkKind, content: string): Promise<void> => {
    try {
      const chunk = await input.prisma.runThinkingChunk.create({
        data: { content, kind, runId: input.runId },
        select: { id: true },
      })
      await input.realtimeTransport.publishSse(
        input.threadId,
        kind === 'tool' ? 'stream.thinking.tool' : 'stream.reasoning',
        {
          // BigInt is not JSON-serializable — always hand the wire a string.
          chunkId: chunk.id.toString(),
          content,
          runId: parseRunId(input.runId),
        },
      )
    } catch (error) {
      console.warn('[worker] thinking recorder failed to record chunk', input.runId, error)
    }
  }

  // Drains whatever reasoning is buffered right now. Called from the queue, so
  // it never races another flush.
  const flushReasoning = async (): Promise<void> => {
    clearBufferTimer()
    const pending = buffer
    buffer = ''
    if (pending.length === 0) return
    await write('reasoning', pending)
  }

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work)
    return queue
  }

  const scheduleFlush = (): void => {
    if (bufferTimer) return
    bufferTimer = setTimeout(() => {
      bufferTimer = null
      void enqueue(flushReasoning)
    }, REASONING_FLUSH_MS)
    // A pending thought flush must never hold the process open.
    bufferTimer.unref?.()
  }

  return {
    appendReasoning: async (delta) => {
      if (closed || delta.length === 0) return
      buffer += delta
      if (buffer.length >= REASONING_FLUSH_BYTES) {
        await enqueue(flushReasoning)
        return
      }
      scheduleFlush()
    },
    appendToolLine: async (toolName, inputSummary) => {
      if (closed) return
      const line = inputSummary ? `${toolName}: ${inputSummary}` : toolName
      await enqueue(async () => {
        // Reasoning that led to this call belongs before it in the log.
        await flushReasoning()
        await write('tool', line)
      })
    },
    close: async () => {
      if (closed) return
      closed = true
      clearBufferTimer()
      await enqueue(flushReasoning)
    },
  }
}
