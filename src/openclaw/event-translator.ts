/**
 * src/openclaw/event-translator.ts — Translates Nessie ServerEvents
 * into OpenClaw-compatible session events.
 *
 * OpenClaw events follow the Gateway WS protocol:
 *   { type: "event", event: "<event_name>", payload: {...}, seq?, stateVersion? }
 *
 * This module converts the Nessie event bus format to that shape.
 */

import type { ServerEvent } from '../events.js'
import { toOpenClawKey } from './session-mapper.js'

export interface OpenClawEvent {
  type: 'event'
  event: string
  payload: Record<string, unknown>
  seq?: number
  stateVersion?: number
}

let seqCounter = 0

function nextSeq(): number {
  return ++seqCounter
}

/**
 * Translate a Nessie ServerEvent into an OpenClaw event.
 * Returns null if the event has no OpenClaw equivalent.
 */
export function translateEvent(nessieEvent: ServerEvent): OpenClawEvent | null {
  const seq = nextSeq()

  switch (nessieEvent.type) {
    case 'task.created': {
      const task = nessieEvent.task
      const sessionKey = toOpenClawKey({
        taskId: task.id,
        threadId: 'main',
        parentTaskId: task.parentId,
      })
      return {
        type: 'event',
        event: 'session.created',
        payload: {
          sessionKey: sessionKey.key,
          agentId: sessionKey.agentId,
          parentSessionKey: task.parentId
            ? toOpenClawKey({ taskId: task.parentId, threadId: 'main', parentTaskId: null }).key
            : null,
          metadata: {
            taskId: task.id,
            role: task.role,
            label: task.label,
            status: task.status,
          },
        },
        seq,
      }
    }

    case 'task.state_changed': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.state_changed',
        payload: {
          sessionKey: sessionKey.key,
          fromStatus: mapStatus(nessieEvent.fromStatus),
          toStatus: mapStatus(nessieEvent.toStatus),
          reason: nessieEvent.reason,
        },
        seq,
      }
    }

    case 'task.spawned': {
      const childKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: nessieEvent.parentTaskId,
      })
      return {
        type: 'event',
        event: 'session.spawned',
        payload: {
          sessionKey: childKey.key,
          parentSessionKey: nessieEvent.parentTaskId
            ? toOpenClawKey({
              taskId: nessieEvent.parentTaskId,
              threadId: 'main',
              parentTaskId: null,
            }).key
            : null,
          agentId: `nessie-${nessieEvent.role}`,
          label: nessieEvent.label,
        },
        seq,
      }
    }

    case 'task.announced': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: nessieEvent.parentTaskId,
      })
      return {
        type: 'event',
        event: 'session.announce',
        payload: {
          sessionKey: sessionKey.key,
          parentSessionKey: nessieEvent.parentTaskId
            ? toOpenClawKey({
              taskId: nessieEvent.parentTaskId,
              threadId: 'main',
              parentTaskId: null,
            }).key
            : null,
          status: nessieEvent.status === 'completed' ? 'success' : nessieEvent.status,
          output: nessieEvent.result,
          cost: {
            durationMs: nessieEvent.duration,
            toolCalls: nessieEvent.toolCallCount,
          },
        },
        seq,
      }
    }

    case 'task.review_passed': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.review',
        payload: {
          sessionKey: sessionKey.key,
          verdict: 'pass',
          reason: nessieEvent.reason,
        },
        seq,
      }
    }

    case 'task.review_failed': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.review',
        payload: {
          sessionKey: sessionKey.key,
          verdict: 'fail',
          reason: nessieEvent.reason,
          repairInstructions: nessieEvent.repairInstructions,
        },
        seq,
      }
    }

    case 'approval.requested': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.approval_requested',
        payload: {
          sessionKey: sessionKey.key,
          reason: nessieEvent.reason,
        },
        seq,
      }
    }

    case 'approval.resolved': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.approval_resolved',
        payload: {
          sessionKey: sessionKey.key,
          resolution: nessieEvent.resolution,
        },
        seq,
      }
    }

    case 'validator.result': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.validator_result',
        payload: {
          sessionKey: sessionKey.key,
          validatorName: nessieEvent.validatorName,
          passed: nessieEvent.passed,
          output: nessieEvent.output,
          durationMs: nessieEvent.durationMs,
        },
        seq,
      }
    }

    case 'watcher.alert': {
      const sessionKey = toOpenClawKey({
        taskId: nessieEvent.taskId,
        threadId: 'main',
        parentTaskId: null,
      })
      return {
        type: 'event',
        event: 'session.watcher_alert',
        payload: {
          sessionKey: sessionKey.key,
          alertType: nessieEvent.alertType,
          message: nessieEvent.message,
        },
        seq,
      }
    }

    case 'message': {
      return {
        type: 'event',
        event: 'session.message',
        payload: {
          sessionKey: `agent:${nessieEvent.message.threadId}:nessie:group:direct`,
          role: nessieEvent.message.role,
          content: nessieEvent.message.content,
          timestamp: nessieEvent.message.timestamp,
        },
        seq,
      }
    }

    // Events without a direct OpenClaw equivalent
    case 'streaming.start':
    case 'streaming.delta':
    case 'streaming.done':
    case 'subagent.started':
    case 'subagent.done':
    case 'tool.called':
    case 'tool.done':
    case 'agent.wake':
    case 'state':
    case 'error':
      return null
  }
}

/**
 * Map Nessie task status strings to OpenClaw-compatible session status strings.
 */
function mapStatus(nessieStatus: string): string {
  const statusMap: Record<string, string> = {
    inbox: 'pending',
    assigned: 'assigned',
    in_progress: 'active',
    review: 'review',
    done: 'completed',
    failed: 'error',
    cancelled: 'cancelled',
    awaiting_approval: 'paused',
  }
  return statusMap[nessieStatus] ?? nessieStatus
}

/**
 * Reset the sequence counter (for testing).
 */
export function resetSeq(): void {
  seqCounter = 0
}
