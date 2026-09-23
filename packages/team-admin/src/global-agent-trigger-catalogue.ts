import {
  describeAgentTriggerTypes,
  TICKET_TRIGGER_LIMIT_CEILINGS,
  TICKET_TRIGGER_LIMIT_DEFAULTS,
} from '@nessie/schemas'

/**
 * The Designer catalogue's trigger half: what can start an agent's work, and
 * how ticket work behaves once it has started. Generated from the typed
 * trigger config union (`AgentTriggerConfigInputSchema`) and its limit
 * constants, never written by hand — the same rule as the rest of
 * `global-agent-catalogue.ts`, of which this is a part split out for size.
 *
 * The ticket-work facts say only what ships (T1 of
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
    'A ticket-work run acts as the agent itself, never as the person who moved the ticket: it reads, '
    + 'comments on and moves its project\'s tickets, and cannot read private documents, schedule tasks, '
    + 'use a mailbox or set anything up. Its ticket comments are read by everyone on the project.',
  ),
  bullet(
    'Ticket work runs on no machine yet: the agent triages, comments on and moves tickets, and cannot '
    + 'run code or start a coding session.',
  ),
]
