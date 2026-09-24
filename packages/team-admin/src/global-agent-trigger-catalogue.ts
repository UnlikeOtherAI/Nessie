import {
  CHECK_BACK_IN_MINUTES,
  describeAgentTriggerTypes,
  TICKET_TRIGGER_LIMIT_CEILINGS,
  TICKET_QUIET_WAKE_MINUTES,
  TICKET_TRIGGER_LIMIT_DEFAULTS,
} from '@nessie/schemas'

/**
 * The Designer catalogue's trigger half: what can start an agent's work, and
 * how ticket work behaves once it has started. Generated from the typed
 * trigger config union (`AgentTriggerConfigInputSchema`) and its limit
 * constants, never written by hand — the same rule as the rest of
 * `global-agent-catalogue.ts`, of which this is a part split out for size.
 *
 * The ticket-work facts say only what ships (T1 and T3 of
 * docs/plans/2026-09-23-ticket-driven-agents): no machine does ticket work
 * yet, so none is promised.
 */

const bullet = (line: string): string => `- ${line}`

export const triggerCatalogueSection = (): string[] => [
  'Triggers — what starts an agent\'s work. Each type an agent may be given, and the settings it takes '
  + '(agent_trigger_create and agent_trigger_update check exactly these):',
  ...describeAgentTriggerTypes(),
  bullet(
    'Scheduled and interval triggers need the creator to have a live SSO identity, because every '
    + 'future run re-uses it.',
  ),
  bullet(
    'Whoever creates a trigger is recorded as its author. That is authorship only: a schedule runs as '
    + 'the person who created it, and every other trigger runs as the agent itself.',
  ),
]

export const ticketWorkFactsSection = (): string[] => [
  'Ticket work (a ticket_changed trigger), as the platform runs it:',
  bullet(
    'Work on a ticket starts only when a person who can edit the board moves it into one of the '
    + 'trigger\'s start-work columns, or creates it there. A move or a create by an agent, an API token '
    + 'or a connected board never starts work.',
  ),
  bullet('At most one enabled trigger picks up from a column; a second one is refused, naming the first.'),
  bullet(
    'Each ticket gets one work thread in the trigger\'s channel, which is why that channel must be '
    + 'public: everyone who can read the ticket can open it. Every later wake for the ticket lands there.',
  ),
  bullet(
    'While the work is live, the follow kinds wake the agent again, but only for a change made by a '
    + 'person who can edit the board — a connected board\'s own changes only with includeSourceEvents, '
    + 'and marked untrusted. Every wake says why the agent woke, the ticket\'s state, and the '
    + 'instructions: general first, then the section for that reason.',
  ),
  bullet(
    'Entering an endOn column ends the work, whoever moved the ticket: the platform ends it, never '
    + 'the agent, which is woken once more only to comment.',
  ),
  bullet(
    `Limits: ${TICKET_TRIGGER_LIMIT_DEFAULTS.wakesPerTicket} model runs per ticket by default `
    + `(wakesPerTicket, at most ${TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket}) and `
    + `${TICKET_TRIGGER_LIMIT_DEFAULTS.startsPerDay} tickets started a day (startsPerDay, at most `
    + `${TICKET_TRIGGER_LIMIT_CEILINGS.startsPerDay}). A ticket that used up its runs stops, and a `
    + 'person restarts it by moving it out of and back into a start-work column.',
  ),
  bullet(
    `The agent can set itself a reminder with check_back_in (${CHECK_BACK_IN_MINUTES.min} to `
    + `${CHECK_BACK_IN_MINUTES.max} minutes and a short note) when it waits for something that will not `
    + 'wake it, such as CI. It replaces the ticket\'s pending reminder, counts as one of the ticket\'s runs '
    + 'when it fires, and people who can edit the board see it on the ticket and can cancel it.',
  ),
  bullet(
    'A ticket comment the agent posts with awaitsAnswer asks the people on the ticket something: while '
    + 'it waits for an answer the work is not woken for being quiet and its hours do not count, and a '
    + 'comment from a person who can edit the board wakes it. It should also set check_back_in, in case '
    + 'nobody answers.',
  ),
  bullet(
    `Live work that has nothing scheduled — no reminder, no question waiting — is woken after `
    + `${TICKET_QUIET_WAKE_MINUTES.default} quiet minutes (quietWakeMinutes, `
    + `${TICKET_QUIET_WAKE_MINUTES.min} to ${TICKET_QUIET_WAKE_MINUTES.max}, or null for off), so a ticket `
    + 'the agent forgot never sits in progress for ever. Each quiet wake counts as one of the ticket\'s runs.',
  ),
  bullet(
    'A ticket-work run acts as the agent itself, never as the person who moved the ticket: it reads, '
    + 'comments on and moves its project\'s tickets, and cannot read private documents, schedule tasks, '
    + 'use a mailbox or set anything up. Its ticket comments are read by everyone on the project.',
  ),
  bullet(
    'Ticket work runs on a machine only under the machine access its trigger\'s author confirmed, once, '
    + 'with their password. Then the agent drives Claude Code sessions on those machines through the '
    + 'coding_session_* tools and no other program there, within the ticket\'s hours and spend limits '
    + '(ticketHours, ticketUsd, dailyUsd). Without it the agent triages, comments on and moves tickets, and '
    + 'cannot run code or start a coding session.',
  ),
]

export const documentTriggerFactsSection = (): string[] => [
  'Document reviews (a document_changed trigger), as the platform runs them:',
  bullet(
    'It watches one document space of its channel\'s project — the whole space, one folder\'s subtree, '
    + 'named pages, or labelled pages. The space must be readable by everyone in the channel, by the '
    + 'agent and by the person setting it up; a refusal names the field.',
  ),
  bullet(
    'Saves inside the quiet window (quietSeconds) wake the agent once, with the whole change. The '
    + 'wake carries no document text: the agent reads the change with kb_page_diff and the ids the '
    + 'wake names. Its own saves never wake it; other agents\' only with includeAgentEdits.',
  ),
  bullet(
    'An edit to a ticket\'s document, while that ticket\'s work is live for the same agent, wakes that '
    + 'work in its ticket thread (reason document_changed) — so a ticket_changed trigger that follows '
    + '"document" hears about spec edits. Any other edit is reviewed in the document\'s own thread in the '
    + 'trigger\'s channel, as the agent itself with no person behind it.',
  ),
  bullet(
    'If the agent loses access to the space, the trigger is switched off with a reason its owner sees.',
  ),
]
