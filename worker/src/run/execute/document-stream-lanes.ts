import type { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'

// Coalescing for the durable lane only — the live lane never batches.
export const DURABLE_FLUSH_BYTES = 2048
export const DURABLE_FLUSH_MS = 250

// A NOTIFY payload is capped at 8000 bytes. Content is JSON-escaped inside an
// envelope, and escaping can roughly double a fragment made of newlines, so a
// fragment is split well below the cap rather than at it.
const MAX_NOTIFY_CONTENT_BYTES = 3_500

// Beyond this many unsent fragments the live lane is visibly behind (a degraded
// database). Merging what is already backed up keeps memory bounded and costs
// no latency — it only ever combines fragments that were waiting anyway.
const MAX_PENDING_FRAGMENTS = 32

type LiveFragment = { content: string; offset: number }

/**
 * Split so no piece exceeds the NOTIFY budget, without ever cutting a surrogate
 * pair — half a pair is not valid text and would break the client's offset
 * arithmetic as well as the rendering.
 */
export const splitForNotify = (fragment: LiveFragment): LiveFragment[] => {
  if (Buffer.byteLength(fragment.content, 'utf8') <= MAX_NOTIFY_CONTENT_BYTES) {
    return [fragment]
  }

  const pieces: LiveFragment[] = []
  let cursor = 0
  let offset = fragment.offset
  while (cursor < fragment.content.length) {
    let take = Math.min(MAX_NOTIFY_CONTENT_BYTES, fragment.content.length - cursor)
    while (
      take > 1
      && Buffer.byteLength(fragment.content.slice(cursor, cursor + take), 'utf8')
        > MAX_NOTIFY_CONTENT_BYTES
    ) {
      take -= 1
    }
    const lastUnit = fragment.content.charCodeAt(cursor + take - 1)
    if (take > 1 && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      take -= 1
    }
    const content = fragment.content.slice(cursor, cursor + take)
    pieces.push({ content, offset })
    offset += content.length
    cursor += take
  }
  return pieces
}

/** Merge adjacent fragments that are already contiguous in the document. */
export const mergeContiguous = (fragments: LiveFragment[]): LiveFragment[] => {
  const merged: LiveFragment[] = []
  for (const fragment of fragments) {
    const previous = merged[merged.length - 1]
    if (previous && previous.offset + previous.content.length === fragment.offset) {
      previous.content += fragment.content
      continue
    }
    merged.push({ ...fragment })
  }
  return merged
}

type LiveLaneInput = {
  publish: (fragment: LiveFragment & { seq: number }) => Promise<void>
}

/**
 * Per-provider-chunk delivery. Nothing here batches or waits on a timer: the
 * whole point of the feature is that a token reaches the browser as it arrives.
 */
export const createLiveLane = (input: LiveLaneInput) => {
  let pending: LiveFragment[] = []
  let draining: Promise<void> = Promise.resolve()
  let seq = 0

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending
      pending = []
      for (const fragment of mergeContiguous(batch)) {
        for (const piece of splitForNotify(fragment)) {
          // Sequence is assigned here, after merging and splitting, so neither
          // can fabricate a gap or a duplicate for the client.
          seq += 1
          try {
            await input.publish({ ...piece, seq })
          } catch (error) {
            console.warn('[worker] document stream live publish failed', error)
          }
        }
      }
    }
  }

  return {
    enqueue: (fragment: LiveFragment): void => {
      pending.push(fragment)
      if (pending.length > MAX_PENDING_FRAGMENTS) {
        pending = mergeContiguous(pending)
      }
      draining = draining.then(drain, drain)
    },
    settle: async (): Promise<void> => {
      await draining
    },
  }
}

type DurableLaneInput = {
  prisma: PrismaClient
  sessionId: string
  /**
   * `append` grows a composed-from-nothing document, so each flush is a new
   * chunk. `snapshot` replaces the stored document wholesale, which is what an
   * *edit* needs: content changes in the middle, and a log of appends could not
   * represent that. Bootstrap concatenates chunks in id order either way, so a
   * single snapshot row reads back correctly with no API change.
   */
  mode?: 'append' | 'snapshot'
  /** Snapshot mode: the current whole document at flush time. */
  readSnapshot?: () => string
}

/**
 * Coalesced persistence, deliberately on its own queue: a slow INSERT here must
 * never delay a live publish. This lane is what a reconnecting or late-joining
 * client bootstraps from, so it trails the live lane by at most one flush.
 */
export const createDurableLane = (input: DurableLaneInput) => {
  let buffer = ''
  let bufferOffset = 0
  let bufferStarted = false
  let timer: NodeJS.Timeout | null = null
  let queue: Promise<void> = Promise.resolve()
  let dirty = false

  const clearFlushTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flushSnapshot = async (): Promise<void> => {
    clearFlushTimer()
    if (!dirty) return
    dirty = false
    const content = input.readSnapshot?.() ?? ''
    try {
      await input.prisma.$transaction([
        input.prisma.runDocumentChunk.deleteMany({ where: { sessionId: input.sessionId } }),
        input.prisma.runDocumentChunk.create({
          data: { content, offset: 0, sessionId: input.sessionId },
        }),
      ])
    } catch (error) {
      console.warn('[worker] document stream snapshot flush failed', error)
    }
  }

  const flush = async (): Promise<void> => {
    if (input.mode === 'snapshot') {
      await flushSnapshot()
      return
    }
    clearFlushTimer()
    if (!bufferStarted || buffer.length === 0) return
    const content = buffer
    const offset = bufferOffset
    buffer = ''
    bufferStarted = false
    try {
      await input.prisma.runDocumentChunk.create({
        data: { content, offset, sessionId: input.sessionId },
      })
    } catch (error) {
      console.warn('[worker] document stream durable flush failed', error)
    }
  }

  const enqueueFlush = (): void => {
    queue = queue.then(flush, flush)
  }

  return {
    append: (fragment: LiveFragment): void => {
      dirty = true
      if (input.mode === 'snapshot') {
        // The snapshot reader owns the content; this only paces the writes.
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            enqueueFlush()
          }, DURABLE_FLUSH_MS)
          timer.unref?.()
        }
        return
      }
      if (!bufferStarted) {
        bufferOffset = fragment.offset
        bufferStarted = true
      }
      buffer += fragment.content
      if (buffer.length >= DURABLE_FLUSH_BYTES) {
        enqueueFlush()
        return
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          enqueueFlush()
        }, DURABLE_FLUSH_MS)
        // A pending flush must never hold the process open.
        timer.unref?.()
      }
    },
    settle: async (): Promise<void> => {
      enqueueFlush()
      await queue
    },
  }
}

export type PublishDocumentEvent = <TEvent extends Parameters<
  PgRealtimeTransport['publishSse']
>[1]>(
  event: TEvent,
  data: Parameters<PgRealtimeTransport['publishSse']>[2],
) => Promise<void>
