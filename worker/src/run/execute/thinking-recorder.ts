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
  /**
   * Flush pending reasoning, then record one tool line immediately. `callId`
   * is the provider's id for the call, under which `linkToolCall` finds the
   * line again once the call has ended.
   */
  appendToolLine: (toolName: string, inputSummary: string, callId?: string) => Promise<void>
  /**
   * Name the `ToolCall` the call recorded as `callId` became on its tool line
   * (`run_thinking_chunks.tool_call_id`), which is how the thought log finds
   * a call's screenshots. A call whose line was never written, or whose id
   * two calls in flight shared, links nothing.
   */
  linkToolCall: (callId: string, toolCallId: string) => Promise<void>
  /** Final flush. Idempotent, and safe to call from a `finally`. */
  close: () => Promise<void>
}

type RecorderInput = {
  prisma: PrismaClient
  realtimeTransport: Pick<PgRealtimeTransport, 'publishSse'>
  runId: string
  threadId: string
  /**
   * Whether the run's reply is restricted *right now*. Evaluated per flush, not
   * captured at construction, because a run becomes restricted mid-loop the
   * moment it reads a privileged source. Reasoning is derived from the very
   * sources the reply is, so it inherits the same boundary; the durable row is
   * still written (the thought log is read back through its own gate) and only
   * the thread-wide live publish is withheld.
   */
  isRestricted?: () => boolean
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
  // The tool line of each call in flight, by the provider's call id; null
  // once two calls in flight claimed the same id, so neither is guessed at.
  const toolLines = new Map<string, bigint | null>()

  const clearBufferTimer = (): void => {
    if (bufferTimer) {
      clearTimeout(bufferTimer)
      bufferTimer = null
    }
  }

  const write = async (kind: RunThinkingChunkKind, content: string): Promise<bigint | null> => {
    try {
      const chunk = await input.prisma.runThinkingChunk.create({
        data: { content, kind, runId: input.runId },
        select: { id: true },
      })
      if (input.isRestricted?.()) {
        return chunk.id
      }
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
      return chunk.id
    } catch (error) {
      console.warn('[worker] thinking recorder failed to record chunk', input.runId, error)
      return null
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
    appendToolLine: async (toolName, inputSummary, callId) => {
      if (closed) return
      const line = inputSummary ? `${toolName}: ${inputSummary}` : toolName
      await enqueue(async () => {
        // Reasoning that led to this call belongs before it in the log.
        await flushReasoning()
        const chunkId = await write('tool', line)
        if (callId === undefined) return
        toolLines.set(callId, toolLines.has(callId) ? null : chunkId)
      })
    },
    linkToolCall: async (callId, toolCallId) => {
      await enqueue(async () => {
        const chunkId = toolLines.get(callId)
        toolLines.delete(callId)
        if (chunkId === undefined || chunkId === null) return
        try {
          await input.prisma.runThinkingChunk.updateMany({
            where: { id: chunkId, runId: input.runId },
            data: { toolCallId },
          })
        } catch (error) {
          console.warn('[worker] thinking recorder failed to link a tool line', input.runId, error)
        }
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
