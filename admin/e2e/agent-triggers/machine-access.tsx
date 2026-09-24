import { ApiClientError } from '@nessie/client-core'
import type {
  PreparedStandingPolicyResponse,
  StandingPolicyMachineOption,
  TriggerMachineAccessView,
} from '@nessie/schemas'

/**
 * The Machine access section's half of the agent-triggers fixture
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * the section's read in each state, the author's machines for the setup form,
 * and a prepare that is refused once for a machine gone offline and then
 * answers the one card, whose Review opens the real access-change dialog.
 *
 * `&access=` picks the state: `not_set_up` (the author, the default for the
 * setup form), `not_set_up_other` (an owner who is not the author),
 * `awaiting` (its card in the author's conversation with the Designer),
 * `awaiting_here` (its card prepared on the page and left unconfirmed), `live`
 * (the author: machines named), `live_other` (an owner: machines not named),
 * `suspended` and `ended`. A trigger edit that pauses it lands through
 * `suspendMachineAccess`.
 */

const TRIGGER = '60000000-0000-4000-8000-000000000021'
const PROJECT = '60000000-0000-4000-8000-000000000011'
const POLICY = '60000000-0000-4000-8000-000000000600'
const ACCESS_CHANGE = '60000000-0000-4000-8000-000000000601'
const MINIS = '60000000-0000-4000-8000-000000000610'
const STUDIO = '60000000-0000-4000-8000-000000000611'
const BARE = '60000000-0000-4000-8000-000000000612'
const AUTHOR = '60000000-0000-4000-8000-000000000620'
// The author's conversation with the Agent Designer, where its card was posted.
export const DESIGNER_DM = {
  channelId: '60000000-0000-4000-8000-000000000650',
  threadId: '60000000-0000-4000-8000-000000000651',
}
const T0 = '2026-09-23T09:00:00.000Z'

export const machineAccessState = new URLSearchParams(location.search).get('access') ?? 'live'
// What the server holds now: a prepare leaves a card out, an End ends it, an edit pauses it.
let current = machineAccessState

/** A saved edit of a pinned field: live access pauses until its author confirms it again. */
export const suspendMachineAccess = (): boolean => {
  if (current !== 'live' && current !== 'live_other') return false
  current = current === 'live' ? 'suspended' : 'suspended_other'
  return true
}

const ticket = (n: number, title: string, extra: Partial<TriggerMachineAccessView['tickets'][number]>) => ({
  machineLabel: null, position: null, projectId: PROJECT, stateReason: null, status: 'active' as const,
  taskId: `60000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  title, workId: `60000000-0000-4000-8000-0000000006${String(30 + n)}`, ...extra,
})

const namedMachines = [{ executorId: MINIS, label: 'Minis' }, { executorId: STUDIO, label: 'Studio' }]

const policyOf = (
  status: 'preparing' | 'live' | 'suspended' | 'ended',
  named: boolean,
  extra: Partial<NonNullable<TriggerMachineAccessView['policy']>> = {},
): NonNullable<TriggerMachineAccessView['policy']> => ({
  allowAnyCommand: false, confirmedAt: status === 'preparing' ? null : T0, createdAt: T0, endedAt: null,
  endedByName: null, endedReason: null, id: POLICY, limits: { dailyUsd: 60, ticketHours: 4, ticketUsd: 20 },
  machineCount: 2, machines: named ? namedMachines : null, status, suspendedReason: null,
  viewerCanEnd: named && status !== 'ended', ...extra,
})

const liveTickets = (named: boolean) => [
  ticket(1, 'NES-140 Fix login redirect', { machineLabel: named ? 'Minis' : null }),
  ticket(2, 'NES-141 Refactor billing', { machineLabel: named ? 'Studio' : null }),
  ticket(5, 'NES-143 Speed up search', { position: 1, stateReason: 'queued_no_free_machine', status: 'queued' }),
  ticket(6, 'NES-144 Tidy settings', { position: 2, stateReason: 'queued_no_free_machine', status: 'queued' }),
]

const VIEWS: Record<string, () => TriggerMachineAccessView> = {
  not_set_up: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: null, pendingCard: null, policy: null, state: 'not_set_up',
    tickets: [ticket(1, 'NES-140 Fix login redirect', { stateReason: 'machine_access_not_set_up', status: 'waiting_machine' })],
    triggerId: TRIGGER, viewerIsAuthor: true,
  }),
  not_set_up_other: () => ({ ...VIEWS.not_set_up!(), viewerIsAuthor: false }),
  awaiting: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: { where: 'conversation', ...DESIGNER_DM },
    pendingCard: null, policy: policyOf('preparing', true), state: 'awaiting_confirmation', tickets: [],
    triggerId: TRIGGER, viewerIsAuthor: true,
  }),
  awaiting_here: () => ({ ...VIEWS.awaiting!(), cardLocation: { where: 'this_page' } }),
  live: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: null, pendingCard: null, policy: policyOf('live', true),
    state: 'live', tickets: liveTickets(true), triggerId: TRIGGER, viewerIsAuthor: true,
  }),
  live_other: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: null, pendingCard: null, policy: policyOf('live', false),
    state: 'live', tickets: liveTickets(false), triggerId: TRIGGER, viewerIsAuthor: false,
  }),
  suspended: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: null, pendingCard: null,
    policy: policyOf('suspended', true, { suspendedReason: 'trigger_changed' }), state: 'suspended',
    tickets: [ticket(1, 'NES-140 Fix login redirect', { stateReason: 'machine_access_suspended', status: 'waiting_machine' })],
    triggerId: TRIGGER, viewerIsAuthor: true,
  }),
  suspended_other: () => ({
    ...VIEWS.suspended!(), policy: policyOf('suspended', false, { suspendedReason: 'trigger_changed' }),
    viewerIsAuthor: false,
  }),
  ended: () => ({
    author: { name: 'Ondrej', userId: AUTHOR }, cardLocation: null, pendingCard: null,
    policy: policyOf('ended', true, { endedAt: T0, endedByName: 'Ondrej', endedReason: 'person', viewerCanEnd: false }),
    state: 'ended', tickets: [], triggerId: TRIGGER, viewerIsAuthor: true,
  }),
}

const machines: StandingPolicyMachineOption[] = [
  {
    executorId: BARE, facts: null, label: 'Bare',
    refusal: {
      reason: 'no_reviewed_coding_sessions',
      sentence: 'Bare has no reviewed coding-sessions bridge. Offer Claude Code in its coding-sessions configuration '
        + 'and approve the new revision on its page.',
    },
  },
  {
    executorId: MINIS, label: 'Minis', refusal: null,
    facts: {
      maxLiveSessionsPerOwner: 3, mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
      permissionMode: 'acceptEdits', rootNames: ['nessie', 'site'], turnBudgetUsd: 5, unaskedCommands: 'listed',
    },
  },
  {
    executorId: STUDIO, label: 'Studio', refusal: null,
    facts: {
      maxLiveSessionsPerOwner: 3, mergeCommands: [], permissionMode: 'bypassPermissions', rootNames: ['nessie'],
      turnBudgetUsd: 8, unaskedCommands: 'any',
    },
  },
]

const card: PreparedStandingPolicyResponse['card'] = {
  actions: [{ key: 'review', label: 'Review', style: 'primary', submits: true }],
  blocks: [
    {
      markdown: 'Anyone who can edit this board — 7 people today, and anyone added to the project later — can make '
        + 'Claude run commands on these machines as you, with your git and coding-agent login.\n\nThe agent may drive Claude Code sessions on these machines; it gets no '
        + 'other program on them.\n\nProject members, organisation owners and people on the ticket see what the work '
        + 'does on the ticket: the coding agent\'s summaries and its pull requests. Pull requests are merged under your '
        + 'GitHub identity.',
      type: 'text',
    },
    {
      items: [
        { label: 'Machines', value: 'Minis' },
        { label: 'Board', value: 'Engineering' },
        { label: 'Starts work in', value: 'In progress' },
        { label: 'Coding agent', value: 'Claude Code, at most $5 a turn on Minis' },
        { label: 'Commands', value: 'Only what each machine\'s reviewed configuration allows without asking' },
        { label: 'Coding roots', value: 'nessie and site' },
        { label: 'Each ticket', value: 'At most 4 hours, $20 and 30 wakes' },
        { label: 'Each day', value: 'At most 20 tickets started and $60 spent' },
      ],
      type: 'fields',
    },
    { markdown: 'Each machine may push, open, watch and merge pull requests without asking.', type: 'text' },
    {
      blocks: [{ markdown: 'Triage every ticket and comment a plan.', type: 'text' }],
      summary: 'The instructions, word for word',
      type: 'details',
    },
    {
      markdown: 'Review opens exactly what you agree to. Nothing is applied until you confirm it there, with your '
        + 'password. This expires in 30 minutes.',
      type: 'text',
    },
  ],
  schemaVersion: 1,
  subtitle: 'Ticket work from "Start work from In progress"',
  title: 'Let CTO use Minis',
} as PreparedStandingPolicyResponse['card']

/** What the section's reads answer; undefined for anything else. */
export const machineAccessGet = (url: URL): unknown => {
  if (url.pathname === `/api/triggers/${TRIGGER}/machine-access`) return (VIEWS[current] ?? VIEWS.live!)()
  if (url.pathname === `/api/triggers/${TRIGGER}/machine-access/machines`) return { machines }
  if (url.pathname === `/api/executor-access-changes/${ACCESS_CHANGE}`) {
    return {
      accessChangeId: ACCESS_CHANGE,
      change: {
        agentId: '60000000-0000-4000-8000-000000000001', kind: 'standing_policy', policyId: POLICY,
        summary: { machineLabels: ['Minis'], triggerName: 'Start work from In progress' },
      },
      executorId: MINIS, expiresAt: '2026-09-23T10:00:00.000Z', requiresFreshVerification: true, status: 'pending',
      verificationMethod: 'password',
    }
  }
  return undefined
}

type Recorded = { body: unknown; path: string }

/**
 * A prepare: the first is refused for a machine that went offline, as the
 * server names each machine it refuses; the next answers the card. An End is
 * recorded. Undefined for any other write.
 */
export const machineAccessPost = (path: string, body: unknown, posted: Recorded[]): unknown => {
  if (path === `/api/triggers/${TRIGGER}/machine-access`) {
    posted.push({ body, path })
    if (posted.filter((entry) => entry.path === path).length === 1) {
      throw new ApiClientError('Minis is offline. Bring it online first.', 'MACHINE_ACCESS_REFUSED', 400, {
        machines: [{ executorId: MINIS, label: 'Minis', reason: 'offline', sentence: 'Minis is offline. Bring it online first.' }],
      })
    }
    // Prepared on this page: the card lives in the section until the page is left.
    current = 'awaiting_here'
    return {
      accessChangeId: ACCESS_CHANGE, card, confirmationToken: 'c'.repeat(43), expiresAt: '2026-09-23T10:00:00.000Z',
      policyId: POLICY, requiresFreshVerification: true,
    } satisfies PreparedStandingPolicyResponse
  }
  if (path === `/api/standing-policies/${POLICY}/end`) {
    posted.push({ body, path })
    current = 'ended'
    return { ended: true }
  }
  return undefined
}
