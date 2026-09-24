import type { Prisma, PrismaClient } from '@prisma/client'
import {
  bindStandingPolicyExecutor,
  recordTicketWorkRunCost,
  type StandingPolicyBinding,
} from '@nessie/executor-manage'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import {
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_PURPOSE,
  TICKET_WORK_STEER_METADATA_KEY,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { canMemberEditProjectBoards, ticketInWorkFlow } from '@nessie/team-admin'

import { loadTicketWorkCodingScope, type TicketWorkCodingScope } from '../ticket-work-coding-sessions.js'

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

/**
 * A `ticket.work` run's setup (docs/standards/ticket-work.md → "A
 * `ticket.work` run acts as the agent"). Kept here rather than in
 * `run-setup.ts`, which is near its size cap.
 *
 * Such a run acts as its agent with no effective user, so:
 * - it is lent the ticket tools that have an agent task actor — reach through
 *   the agent's live binding, writes credited `agent:<id>` with the run — and
 *   only those its policy grants (`isProjectDelegatedRun`'s own arm);
 * - it is never offered, and refuses, the tools that act as or for a person or
 *   arm unattended work: schedules and every mail tool. Identity tools and
 *   setup verbs refuse on their own, because nothing admits them without a
 *   live person (`requireActingUserId`);
 * - its conversation is the agent's own replies and the messages people who
 *   can edit the board wrote in the thread (stamped `ticketWorkSteer`), never
 *   anything else a room might hold;
 * - it starts having read its ticket's project, because every kickoff is built
 *   from that ticket: what it writes outside that project's audience carries
 *   the project's basis.
 */

/**
 * The project tools a `ticket.work` run may be lent. Each has an agent task
 * actor path; the rest of the peer set needs a person (a ticket's creator or
 * assigner is checked against one, a checklist template is a person's to copy,
 * a file is someone's upload), and creating boards or labels is a setup verb
 * for a live requester.
 */
export const TICKET_WORK_PROJECT_TOOL_IDS: ReadonlySet<string> = new Set([
  'ticket_list', 'ticket_read', 'ticket_board_read', 'ticket_update', 'ticket_move', 'ticket_transition',
  'ticket_checklist_read', 'ticket_labels_read', 'ticket_comment_list', 'ticket_comment_add',
  'ticket_attachment_list',
])

/**
 * Withheld from a `ticket.work` run and refused if called: without a person
 * behind the run they would fall back to the agent's own authority, which is
 * exactly the authority a ticket must not widen — an unattended schedule, a
 * mailbox granted to the agent, a person's Google account. `card_post` too: an
 * unattended run's card is answerable by anyone who reads the channel, and an
 * answer would steer the work from outside the board's editors, so the agent
 * asks through the ticket's comments instead.
 */
export const TICKET_WORK_PERSON_TOOL_IDS: ReadonlySet<string> = new Set([
  'card_post',
  'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task',
  'email_list', 'email_read', 'email_send', 'email_account_list', 'email_account_connect',
  'email_account_check', 'email_account_disconnect', 'email_account_agent_access',
  'gmail_search', 'gmail_thread_read', 'gmail_message_read', 'gmail_draft_create', 'gmail_draft_update',
  'gmail_draft_send', 'gmail_labels_list', 'gmail_organise', 'gmail_attachment_read',
  'calendar_list', 'calendar_events_list', 'calendar_freebusy', 'calendar_event_create',
  'calendar_event_update', 'calendar_event_cancel', 'calendar_event_respond', 'contacts_search',
  'mailbox_search', 'mailbox_read', 'mailbox_compose', 'mailbox_send', 'mail_present',
])

/** Structural, from the run's own action purpose. A context-less caller (a partial fixture) is no ticket work. */
export const isTicketWorkRun = (actorContext: Pick<AuthorizedActionContext, 'actionContext'> | undefined): boolean =>
  actorContext?.actionContext?.purpose === TICKET_WORK_PURPOSE

/**
 * A `ticket.work` run takes no recalled history and no recalled memory. Its
 * work thread is a conversation with its agent, so recall would search that
 * same thread — and return the messages its conversation window leaves out:
 * another agent's replies, a person's unstamped words. What the run knows is
 * its kickoff, rebuilt from the record, and that filtered window.
 */
export const ticketWorkRecallSkipped = (
  actorContext: Pick<AuthorizedActionContext, 'actionContext'> | undefined,
): boolean => isTicketWorkRun(actorContext)

/** Why a tool refuses on a `ticket.work` run, or null when it may run. */
export const ticketWorkToolRefusal = (
  toolName: string,
  actorContext: Pick<AuthorizedActionContext, 'actionContext'> | undefined,
): string | null =>
  isTicketWorkRun(actorContext) && TICKET_WORK_PERSON_TOOL_IDS.has(toolName)
    ? `${toolName} needs a person behind the run, and ticket work has none: you act as yourself. `
      + 'Comment on the ticket to ask the people on it instead.'
    : null

/**
 * Where a `ticket.work` run may put what it read from its machine
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Disclosure"):
 * only that ticket's comments and its work thread — the run's own replies. The
 * run is stamped with its thread's channel as the launch conversation, which
 * already admits host output to that project's board; this is narrower. Once
 * a machine has answered, every tool that writes somewhere else refuses:
 * another channel, another ticket, a document, a mail, a peer. What stays:
 * commenting on, moving or transitioning its own ticket — the other ticket a
 * call names is refused at `authorizeToolExecution`
 * (`ticketWorkStandingRefusal`), and `ticket_comment_add` admits only this
 * ticket anyway (`assertProjectWriteDestination`) — `check_back_in`, which
 * writes only its own reminder, and the coding session tools, which are the
 * machine's own and are not builtins.
 */
export const TICKET_WORK_HOST_OUTPUT_REFUSAL = 'This run has read the machine\'s output, which may be posted only to '
  + 'this ticket\'s comments and its work thread: say it there instead.'

export const TICKET_WORK_HOST_OUTPUT_WRITES: ReadonlySet<string> = new Set([
  'ticket_comment_add', 'ticket_move', 'ticket_transition', 'check_back_in',
])

const WRITING_TOOL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => !tool.safe).map((tool) => tool.id),
)

/** Why a tool refuses on a `ticket.work` run that has read host output, or null. */
export const ticketWorkHostOutputRefusal = (
  toolName: string,
  context: {
    actorContext: Pick<AuthorizedActionContext, 'actionContext'> | undefined
    consumedSources?: { hostOutputScopes: () => readonly unknown[] } | undefined
  },
): string | null => isTicketWorkRun(context.actorContext)
  && (context.consumedSources?.hostOutputScopes().length ?? 0) > 0
  && WRITING_TOOL_IDS.has(toolName)
  && !TICKET_WORK_HOST_OUTPUT_WRITES.has(toolName)
  ? TICKET_WORK_HOST_OUTPUT_REFUSAL
  : null

export type TicketWorkRunFacts = {
  /** The record has started a coding session, ever: what its machine answered is in its history. */
  heldSessions: boolean
  live: boolean
  projectId: string
  taskId: string
  workId: string
}

/**
 * The work record this run serves, re-read at setup: it must name this agent
 * and this thread. Null for any other run, and for a `ticket.work` run whose
 * record does not match — which is then lent no ticket tools at all.
 */
export const loadTicketWorkRunFacts = async (
  prisma: Pick<PrismaClient, 'agentTicketWork'>,
  input: {
    actorContext: Pick<AuthorizedActionContext, 'actionContext'>
    agentId: string
    threadId: string
  },
): Promise<TicketWorkRunFacts | null> => {
  const workId = input.actorContext.actionContext.ticketWorkId
  if (!isTicketWorkRun(input.actorContext) || !workId) return null
  const work = await prisma.agentTicketWork.findFirst({
    where: { id: workId, agentId: input.agentId, threadId: input.threadId },
    select: { projectId: true, sessionIds: true, taskId: true, status: true },
  })
  return work
    ? {
        heldSessions: work.sessionIds.length > 0,
        live: LIVE.has(work.status),
        projectId: work.projectId,
        taskId: work.taskId,
        workId,
      }
    : null
}

/**
 * The machine a `ticket.work` run may use: its record's pinned machine, bound
 * afresh under the trigger's standing policy with every check run again
 * (`bindStandingPolicyExecutor`, docs/standards/ticket-work-machine-access.md).
 * The author's right to edit the board, and whether the ticket is still in
 * the trigger's flow, are team-admin's rules, handed in. A failure to bind is
 * an outcome the run is told of, never a failed run: the binder turns an
 * unexpected error into a `bind_failed` refusal, and one before it has read
 * the record leaves the run with no machine, as a refusal does.
 */
export type TicketWorkMachine = { binding: StandingPolicyBinding; coding: TicketWorkCodingScope | null }

export const bindTicketWorkMachine = async (
  prisma: PrismaClient,
  input: { job: RunExecuteJobPayload; runId: string; workId: string },
): Promise<TicketWorkMachine | undefined> => {
  try {
    const binding = await bindStandingPolicyExecutor(prisma, { job: input.job, runId: input.runId }, {
      workId: input.workId,
    }, {
      canEditBoard: (check) => canMemberEditProjectBoards(prisma, check),
      ticketInFlow: (check) => ticketInWorkFlow(prisma, check),
    })
    const bound = binding.kind === 'bound' || binding.kind === 'already_bound'
    return {
      binding,
      coding: bound ? await loadTicketWorkCodingScope(prisma, { runId: input.runId, workId: input.workId }) : null,
    }
  } catch (error) {
    console.warn('[worker] the standing machine access bind failed for run', input.runId, error)
    return undefined
  }
}

/**
 * A `ticket.work` run's own Nessie cost, once its ledger rows are written: it
 * counts against its ticket's `ticketUsd` and its policy's `dailyUsd` beside
 * the coding cost. Never fails the run it describes.
 */
export const recordTicketWorkRunSpend = async (
  prisma: PrismaClient,
  input: { actorContext: Pick<AuthorizedActionContext, 'actionContext'>; runId: string },
): Promise<void> => {
  const workId = input.actorContext.actionContext.ticketWorkId
  if (!isTicketWorkRun(input.actorContext) || !workId) return
  await recordTicketWorkRunCost(prisma, { runId: input.runId, workId }).catch((error: unknown) => {
    console.warn('[worker] could not add the run\'s cost to its ticket\'s work', input.runId, error)
  })
}

/** The lent tools that change a ticket — its fields, its column, its status. */
const TICKET_WORK_WRITE_TOOL_IDS: ReadonlySet<string> = new Set(['ticket_update', 'ticket_move', 'ticket_transition'])

/**
 * A run of work that has already ended — its kickoff pended while the ticket
 * left the flow, say — reads and comments, and changes nothing: it could
 * otherwise move the ticket straight back into the flow on a stale plan.
 */
export const withoutEndedWorkWrites = (
  lent: Set<string>,
  ticketWork: Pick<TicketWorkRunFacts, 'live'> | null,
): Set<string> =>
  ticketWork && !ticketWork.live ? new Set([...lent].filter((id) => !TICKET_WORK_WRITE_TOOL_IDS.has(id))) : lent

/**
 * The messages a `ticket.work` run's conversation admits: the agent's own
 * replies and people's stamped messages in the thread. Kickoffs and wake rows
 * are `system` and never loaded; the current kickoff is the run's prompt.
 */
export const ticketWorkConversationWhere = (agentId: string): Prisma.MessageWhereInput => ({
  OR: [
    { role: 'assistant', agentId },
    { role: 'user', metadata: { path: [TICKET_WORK_STEER_METADATA_KEY], equals: true } },
  ],
})
