/**
 * An agent's work on the task-dialog fixture's ticket, as
 * `GET /api/tasks/:id/work` answers it, in each state T1 reaches: working,
 * parked in review, parked after a move back that did not resume it, stopped
 * at its wake limit, done, one whose thread the reader may not open, and a
 * move that started nothing — each with the ticket's work history — and the
 * T3 states: a pending reminder, for a board editor who may cancel it and a
 * reader who may not, and a question the agent waits on
 * (docs/standards/ticket-work.md → "What the project sees"). And T4's machine
 * states: queued at position 2, paused with its machine offline, waiting for
 * machine access its owner has not set up or has paused, stopped at its hours
 * or its budget, ended with its machine access, a wake that ran without a
 * machine, and a history of a queue, an offline pause and two resumes. None
 * of it names a machine, because the record the chip reads carries none.
 */

import { standingPolicyRefusalSentence } from '@nessie/schemas'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const WORK_TRIGGER = '70000000-0000-4000-8000-000000000013'
export const WORK_REMINDER = '70000000-0000-4000-8000-000000000014'

const workRecord = (agentId: string, extra: Record<string, unknown>) => ({
  agent: { id: agentId, name: 'Perf agent' }, endedAt: null, id: '70000000-0000-4000-8000-000000000010',
  lastWakeAt: minutesAgo(4), lastWakeReason: 'ticket_commented', startedAt: minutesAgo(52),
  startedByName: 'Ondřej Rafaj', stateReason: null, status: 'active',
  thread: { channelId: '70000000-0000-4000-8000-000000000011', id: '70000000-0000-4000-8000-000000000012' },
  triggerId: WORK_TRIGGER, wakeCount: 3, wakeLimit: 30, pendingReminder: null, awaitingAnswerAt: null, ...extra,
})

// The ticket's `work_*` rows, newest first, as the chip's history lists them.
const historyRow = (
  index: number, eventType: string, status: string, byName: string | null, reason: string | null,
  minutes = 52 - index * 10,
) => ({
  agentName: 'Perf agent', at: minutesAgo(minutes), byName, eventType,
  id: `70000000-0000-4000-8000-00000000002${index}`, reason, status,
})
const HISTORY = {
  started: historyRow(0, 'work_started', 'active', 'Ondřej Rafaj', null),
  paused: historyRow(1, 'work_paused', 'parked', 'Perf agent', null),
  resumed: historyRow(2, 'work_resumed', 'active', 'Ondřej Rafaj', null),
  ended: historyRow(3, 'work_ended', 'done', 'Ondřej Rafaj', 'left_flow'),
}

// T4's rows, as the worker writes them: a start no machine took, the queue it
// joined, its turn coming, its machine going offline and coming back.
const MACHINE_HISTORY = {
  startedQueued: historyRow(4, 'work_started', 'queued', 'Ondřej Rafaj', 'queued_no_free_machine', 52),
  queued: historyRow(5, 'work_queued', 'queued', 'Ondřej Rafaj', 'queued_no_free_machine', 52),
  dequeued: historyRow(6, 'work_resumed', 'active', null, null, 40),
  offline: historyRow(7, 'work_paused', 'waiting_machine', null, 'machine_offline', 20),
  back: historyRow(8, 'work_resumed', 'active', null, null, 5),
  startedNoAccess: historyRow(9, 'work_started', 'waiting_machine', 'Ondřej Rafaj', 'machine_access_not_set_up', 52),
}
const machineRows = (eventType: string, status: string, reason: string) =>
  [historyRow(3, eventType, status, null, reason, 2), HISTORY.started]

const skip = (reentry: boolean) =>
  ({ agentName: 'Perf agent', at: minutesAgo(1), reason: 'agent_origin', reentry, triggerId: WORK_TRIGGER })

/** Its `check_back_in`, due in 20 minutes; gone once a board editor cancels it. */
const reminder = { dueAt: new Date(Date.now() + 20 * 60_000).toISOString(), id: WORK_REMINDER, note: 'waiting for CI' }

export const ticketWorkFor = (state: string | null, agentId: string, options: { reminderCancelled?: boolean } = {}) => {
  const record = (extra: Record<string, unknown>) => workRecord(agentId, extra)
  const answer = <T extends { records: ReturnType<typeof record>[] }>(value: T) =>
    ({ viewerCanEditBoard: true, ...value })
  switch (state) {
    case 'active': return answer({
      history: [HISTORY.resumed, HISTORY.paused, HISTORY.started], lastSkip: null, records: [record({})],
    })
    case 'nolink': return answer({ history: [HISTORY.started], lastSkip: null, records: [record({ thread: null })] })
    case 'parked': return answer({
      history: [HISTORY.paused, HISTORY.started], lastSkip: null,
      records: [record({ lastWakeReason: 'ticket_moved', status: 'parked' })],
    })
    // Parked, and an agent's move back into the start-work column refused.
    case 'reentry': return answer({
      history: [HISTORY.paused, HISTORY.started], lastSkip: skip(true),
      records: [record({ lastWakeReason: 'ticket_moved', status: 'parked' })],
    })
    case 'stopped': return answer({ history: [HISTORY.started], lastSkip: null, records: [record({
      endedAt: minutesAgo(1), lastWakeReason: 'thread_message', stateReason: 'limit_wakes', status: 'failed', wakeCount: 30,
    })] })
    case 'done': return answer({ history: [HISTORY.ended, HISTORY.started], lastSkip: null, records: [record({
      endedAt: minutesAgo(2), lastWakeReason: 'ticket_moved', stateReason: 'left_flow', status: 'done',
    })] })
    case 'skipped': return answer({ history: [], lastSkip: skip(false), records: [] })
    // The agent set a reminder: a board editor sees Cancel, a reader does not.
    case 'reminder':
    case 'reminder-reader': return answer({
      history: [HISTORY.started], lastSkip: null,
      records: [record({ lastWakeReason: 'quiet', pendingReminder: options.reminderCancelled ? null : reminder })],
      viewerCanEditBoard: state === 'reminder',
    })
    // The agent's latest comment asked the people on the ticket something.
    case 'question': return answer({
      history: [HISTORY.started], lastSkip: null,
      records: [record({ awaitingAnswerAt: minutesAgo(6), lastWakeReason: 'reminder', wakeCount: 5 })],
    })
    // T4: second in the machine queue, every machine busy.
    case 'queued': return answer({
      history: [MACHINE_HISTORY.queued, MACHINE_HISTORY.startedQueued], lastSkip: null,
      records: [record({
        lastWakeReason: 'queued', queuePosition: 2, stateReason: 'queued_no_free_machine', status: 'queued',
        wakeCount: 1,
      })],
    })
    // The machine the work holds went offline; it resumes when that machine reconnects.
    case 'machine-offline': return answer({
      history: machineRows('work_paused', 'waiting_machine', 'machine_offline'), lastSkip: null,
      records: [record({ stateReason: 'machine_offline', status: 'waiting_machine' })],
    })
    // The trigger's machine access was never set up, or its owner paused it.
    case 'access-not-set-up': return answer({
      history: [MACHINE_HISTORY.startedNoAccess], lastSkip: null,
      records: [record({
        lastWakeReason: 'pickup', stateReason: 'machine_access_not_set_up', status: 'waiting_machine', wakeCount: 1,
      })],
    })
    case 'access-suspended': return answer({
      history: machineRows('work_paused', 'waiting_machine', 'machine_access_suspended'), lastSkip: null,
      records: [record({ stateReason: 'machine_access_suspended', status: 'waiting_machine' })],
    })
    // Stopped at T4's hour or budget limit, well short of its wakes.
    case 'stopped-hours':
    case 'stopped-cost': {
      const reason = state === 'stopped-hours' ? 'limit_hours' : 'limit_cost'
      return answer({
        history: machineRows('work_ended', 'failed', reason), lastSkip: null,
        records: [record({
          endedAt: minutesAgo(2), lastWakeReason: 'session_turn_ended', stateReason: reason, status: 'failed',
          wakeCount: 12,
        })],
      })
    }
    case 'access-ended': return answer({
      history: machineRows('work_ended', 'cancelled', 'machine_access_ended'), lastSkip: null,
      records: [record({ endedAt: minutesAgo(2), stateReason: 'machine_access_ended', status: 'cancelled' })],
    })
    // Live work whose latest wake the standing-policy binder ran without a machine.
    case 'machine-refusal': return answer({
      history: [HISTORY.started], lastSkip: null,
      records: [record({
        machineRefusal: {
          at: minutesAgo(4),
          reason: 'machine_unavailable',
          sentence: standingPolicyRefusalSentence('machine_unavailable'),
        },
      })],
    })
    // Queued at the start, its turn came, its machine went offline and came back.
    case 'machine-history': return answer({
      history: [
        MACHINE_HISTORY.back, MACHINE_HISTORY.offline, MACHINE_HISTORY.dequeued,
        MACHINE_HISTORY.queued, MACHINE_HISTORY.startedQueued,
      ],
      lastSkip: null,
      records: [record({ lastWakeAt: minutesAgo(5), lastWakeReason: 'machine_back_online', wakeCount: 6 })],
    })
    default: return answer({ history: [], lastSkip: null, records: [] })
  }
}
