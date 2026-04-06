/**
 * src/openclaw/announce-converter.ts — Converts Nessie announce payloads
 * to OpenClaw-compatible announce format.
 *
 * OpenClaw announce includes: sessionId, parentSessionId, status,
 * output, cost (tokens, duration), stats (toolCalls), transcript pointer.
 */

import { toOpenClawKey } from './session-mapper.js'

export interface NessieAnnounce {
  taskId: string
  parentTaskId: string | null
  status: 'completed' | 'failed' | 'timeout'
  result: string
  duration: number
  toolCallCount: number
}

export interface OpenClawAnnounce {
  sessionId: string
  parentSessionId: string | null
  status: 'success' | 'error' | 'timeout'
  output: string
  cost: {
    durationMs: number
  }
  stats: {
    toolCalls: number
  }
}

/**
 * Convert a Nessie announce payload to OpenClaw format.
 */
export function toOpenClawAnnounce(announce: NessieAnnounce): OpenClawAnnounce {
  const sessionKey = toOpenClawKey({
    taskId: announce.taskId,
    threadId: 'main',
    parentTaskId: announce.parentTaskId,
  })

  const parentSessionKey = announce.parentTaskId
    ? toOpenClawKey({
      taskId: announce.parentTaskId,
      threadId: 'main',
      parentTaskId: null,
    }).key
    : null

  const statusMap: Record<string, OpenClawAnnounce['status']> = {
    completed: 'success',
    failed: 'error',
    timeout: 'timeout',
  }

  return {
    sessionId: sessionKey.key,
    parentSessionId: parentSessionKey,
    status: statusMap[announce.status] ?? 'error',
    output: announce.result,
    cost: { durationMs: announce.duration },
    stats: { toolCalls: announce.toolCallCount },
  }
}
