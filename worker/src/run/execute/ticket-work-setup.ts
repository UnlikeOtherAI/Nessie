import type { Prisma, PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_PURPOSE,
  TICKET_WORK_STEER_METADATA_KEY,
  type AuthorizedActionContext,
} from '@nessie/schemas'

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

export type TicketWorkRunFacts = { workId: string; projectId: string; taskId: string }

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
    select: { projectId: true, taskId: true },
  })
  return work ? { workId, ...work } : null
}

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
