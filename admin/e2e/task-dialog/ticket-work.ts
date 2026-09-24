/**
 * An agent's work on the task-dialog fixture's ticket, as
 * `GET /api/tasks/:id/work` answers it, in each state T1 reaches: working,
 * parked in review, parked after a move back that did not resume it, stopped
 * at its wake limit, done, one whose thread the reader may not open, and a
 * move that started nothing — each with the ticket's work history
 * (docs/standards/ticket-work.md → "What the project sees").
 */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const WORK_TRIGGER = '70000000-0000-4000-8000-000000000013'

const workRecord = (agentId: string, extra: Record<string, unknown>) => ({
  agent: { id: agentId, name: 'Perf agent' }, endedAt: null, id: '70000000-0000-4000-8000-000000000010',
  lastWakeAt: minutesAgo(4), lastWakeReason: 'ticket_commented', startedAt: minutesAgo(52),
  startedByName: 'Ondřej Rafaj', stateReason: null, status: 'active',
  thread: { channelId: '70000000-0000-4000-8000-000000000011', id: '70000000-0000-4000-8000-000000000012' },
  triggerId: WORK_TRIGGER, wakeCount: 3, wakeLimit: 30, ...extra,
})

// The ticket's `work_*` rows, newest first, as the chip's history lists them.
const historyRow = (
  index: number, eventType: string, status: string, byName: string | null, reason: string | null,
) => ({
  agentName: 'Perf agent', at: minutesAgo(52 - index * 10), byName, eventType,
  id: `70000000-0000-4000-8000-00000000002${index}`, reason, status,
})
const HISTORY = {
  started: historyRow(0, 'work_started', 'active', 'Ondřej Rafaj', null),
  paused: historyRow(1, 'work_paused', 'parked', 'Perf agent', null),
  resumed: historyRow(2, 'work_resumed', 'active', 'Ondřej Rafaj', null),
  ended: historyRow(3, 'work_ended', 'done', 'Ondřej Rafaj', 'left_flow'),
}

const skip = (reentry: boolean) =>
  ({ agentName: 'Perf agent', at: minutesAgo(1), reason: 'agent_origin', reentry, triggerId: WORK_TRIGGER })

export const ticketWorkFor = (state: string | null, agentId: string) => {
  const record = (extra: Record<string, unknown>) => workRecord(agentId, extra)
  switch (state) {
    case 'active': return {
      history: [HISTORY.resumed, HISTORY.paused, HISTORY.started], lastSkip: null, records: [record({})],
    }
    case 'nolink': return { history: [HISTORY.started], lastSkip: null, records: [record({ thread: null })] }
    case 'parked': return {
      history: [HISTORY.paused, HISTORY.started], lastSkip: null,
      records: [record({ lastWakeReason: 'ticket_moved', status: 'parked' })],
    }
    // Parked, and an agent's move back into the start-work column refused.
    case 'reentry': return {
      history: [HISTORY.paused, HISTORY.started], lastSkip: skip(true),
      records: [record({ lastWakeReason: 'ticket_moved', status: 'parked' })],
    }
    case 'stopped': return { history: [HISTORY.started], lastSkip: null, records: [record({
      endedAt: minutesAgo(1), lastWakeReason: 'thread_message', stateReason: 'limit_wakes', status: 'failed', wakeCount: 30,
    })] }
    case 'done': return { history: [HISTORY.ended, HISTORY.started], lastSkip: null, records: [record({
      endedAt: minutesAgo(2), lastWakeReason: 'ticket_moved', stateReason: 'left_flow', status: 'done',
    })] }
    case 'skipped': return { history: [], lastSkip: skip(false), records: [] }
    default: return { history: [], lastSkip: null, records: [] }
  }
}
