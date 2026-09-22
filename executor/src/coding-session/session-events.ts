import { open, rename, stat, type FileHandle } from 'node:fs/promises'

import type { CodingSessionPaths } from './session-files.js'
import type { CodingEventBody, CodingSessionEvent } from './types.js'

/**
 * `events.jsonl`: projected events, appended by the host alone, read by the
 * bridge through a cursor of `generation.byteOffset.seq`.
 *
 * A reader consumes only newline-terminated lines, so a line the host is half
 * way through writing is never parsed and never skipped — the next read picks
 * it up whole. Rotation at 16 MiB moves the file aside once and bumps the
 * generation; a cursor from an older generation restarts at the top of the
 * new file and says so.
 */
export const EVENTS_ROTATE_BYTES = 16 * 1024 * 1024

export type EventCursor = { generation: number; offset: number; seq: number }

export const encodeEventCursor = (cursor: EventCursor): string => `${cursor.generation}.${cursor.offset}.${cursor.seq}`

export const parseEventCursor = (value: unknown): EventCursor | undefined => {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,6})\.(\d{1,12})\.(\d{1,12})$/u.exec(value)
  if (!match) return undefined
  return { generation: Number(match[1]), offset: Number(match[2]), seq: Number(match[3]) }
}

export type EventLog = {
  append: (body: CodingEventBody) => Promise<CodingSessionEvent>
  close: () => Promise<void>
}

export const openEventLog = async (
  paths: CodingSessionPaths,
  position: { generation: number; lastSeq: number },
  onAppend: (position: { generation: number; lastSeq: number }) => void,
  rotateBytes = EVENTS_ROTATE_BYTES,
): Promise<EventLog> => {
  let generation = position.generation
  let seq = position.lastSeq
  let handle: FileHandle = await open(paths.events, 'a', 0o600)
  let size = (await handle.stat()).size
  let queue: Promise<unknown> = Promise.resolve()
  const appendOne = async (body: CodingEventBody): Promise<CodingSessionEvent> => {
    seq += 1
    const event = { seq, at: new Date().toISOString(), ...body } as CodingSessionEvent
    const line = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(line)
    if (size > 0 && size + bytes > rotateBytes) {
      await handle.close()
      await rename(paths.events, paths.previousEvents)
      generation += 1
      handle = await open(paths.events, 'a', 0o600)
      size = 0
    }
    await handle.write(line)
    size += bytes
    onAppend({ generation, lastSeq: seq })
    return event
  }
  return {
    append: (body) => {
      const next = queue.then(() => appendOne(body))
      queue = next.catch(() => undefined)
      return next
    },
    close: async () => {
      await queue
      await handle.close()
    },
  }
}

export type EventPage = {
  events: CodingSessionEvent[]
  /** The cursor just past each event, so a caller that keeps fewer can still resume exactly. */
  positions: EventCursor[]
  next: EventCursor
  /** Events between the cursor and the top of the current file were rotated away. */
  rotated: boolean
  /** More complete lines remain after `next`. */
  more: boolean
}

export const readEventPage = async (
  paths: CodingSessionPaths,
  generation: number,
  cursor: EventCursor | undefined,
  limits: { maxBytes: number; maxEvents: number },
): Promise<EventPage> => {
  const rotated = cursor !== undefined && cursor.generation !== generation
  let start = cursor && !rotated ? cursor.offset : 0
  const size = await stat(paths.events).then((info) => info.size, () => 0)
  if (start > size) start = 0
  const empty: EventPage = {
    events: [], positions: [], next: { generation, offset: start, seq: cursor?.seq ?? 0 }, rotated, more: false,
  }
  if (start === size) return empty
  const length = Math.min(limits.maxBytes, size - start)
  const buffer = Buffer.alloc(length)
  const handle = await open(paths.events, 'r').catch(() => undefined)
  if (!handle) return empty
  try {
    await handle.read(buffer, 0, length, start)
  } finally {
    await handle.close()
  }
  const events: CodingSessionEvent[] = []
  const positions: EventCursor[] = []
  let consumed = 0
  let seq = cursor?.seq ?? 0
  while (events.length < limits.maxEvents) {
    const newline = buffer.indexOf(0x0a, consumed)
    if (newline < 0) break
    const text = buffer.subarray(consumed, newline).toString('utf8')
    consumed = newline + 1
    try {
      const event = JSON.parse(text) as CodingSessionEvent
      events.push(event)
      seq = event.seq
      positions.push({ generation, offset: start + consumed, seq })
    } catch {
      // A line that is not JSON cannot have come from the host; skip it.
    }
  }
  const offset = start + consumed
  return { events, positions, next: { generation, offset, seq }, rotated, more: offset < size }
}
