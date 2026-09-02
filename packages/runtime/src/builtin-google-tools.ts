import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * Gmail and Calendar tools.
 *
 * Every one carries `requiresExplicitGrant`, so an owner grants the bundle per
 * agent and a custom agent reaches them exactly as the Personal Assistant does.
 * They act with the requesting person's own Google credential, resolved at the
 * shared chokepoint, and each read feeds the run's disclosure sink — an agent
 * answering from your inbox produces a reply restricted to you.
 *
 * The send tools additionally carry `requiresApproval`. That flag is
 * STRUCTURAL, declared here in code rather than left to a seeded `PolicyRule`,
 * because the policy evaluator's default verdict is `allow`: a data-driven gate
 * would simply be absent in any organization whose seed never ran.
 */

export const GMAIL_SEARCH_TOOL_ID = 'gmail_search'
export const GMAIL_THREAD_READ_TOOL_ID = 'gmail_thread_read'
export const GMAIL_MESSAGE_READ_TOOL_ID = 'gmail_message_read'
export const GMAIL_DRAFT_CREATE_TOOL_ID = 'gmail_draft_create'
export const GMAIL_DRAFT_UPDATE_TOOL_ID = 'gmail_draft_update'
export const GMAIL_DRAFT_SEND_TOOL_ID = 'gmail_draft_send'
export const CALENDAR_LIST_TOOL_ID = 'calendar_list'
export const CALENDAR_EVENTS_LIST_TOOL_ID = 'calendar_events_list'
export const CALENDAR_FREEBUSY_TOOL_ID = 'calendar_freebusy'
export const CALENDAR_EVENT_CREATE_TOOL_ID = 'calendar_event_create'
export const CALENDAR_EVENT_UPDATE_TOOL_ID = 'calendar_event_update'
export const CALENDAR_EVENT_CANCEL_TOOL_ID = 'calendar_event_cancel'

const addressArray = (description: string) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description,
})

export const GOOGLE_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: GMAIL_SEARCH_TOOL_ID,
    summary: "Search the requesting person's email.",
    label: 'Search Email',
    requiresExplicitGrant: true,
    safe: true,
    description:
      'Search the requesting person’s Gmail and return matching threads with '
      + 'sender, subject, snippet and date. `query` accepts Gmail’s own search '
      + 'operators (from:, to:, subject:, has:attachment, newer_than:7d, '
      + 'is:unread), so prefer a precise query over fetching everything.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query. Omit to list the most recent mail.',
        },
        maxResults: {
          type: 'number',
          description: 'How many threads to return (1–50, default 15).',
        },
      },
    },
  },
  {
    id: GMAIL_THREAD_READ_TOOL_ID,
    summary: 'Read every message in one email thread.',
    label: 'Read Email Thread',
    requiresExplicitGrant: true,
    safe: true,
    description:
      'Read the full text of every message in one Gmail thread, oldest first. '
      + 'Use after gmail_search to get the detail behind a result.',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Gmail thread id.' },
      },
      required: ['threadId'],
    },
  },
  {
    id: GMAIL_MESSAGE_READ_TOOL_ID,
    summary: 'Read one email message in full.',
    label: 'Read Email',
    requiresExplicitGrant: true,
    safe: true,
    description: 'Read one Gmail message in full, including its attachment list.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Gmail message id.' },
      },
      required: ['messageId'],
    },
  },
  {
    id: GMAIL_DRAFT_CREATE_TOOL_ID,
    summary: 'Compose an email draft and show it in the chat for approval.',
    label: 'Draft Email',
    requiresExplicitGrant: true,
    safe: false,
    description:
      'Compose an email as the requesting person and post it into the chat as '
      + 'a card showing recipients, CC, subject and body, with a Send button. '
      + 'This creates a real draft in their Gmail; it does NOT send. Use this '
      + 'whenever asked to write, prepare or draft an email.',
    parameters: {
      type: 'object',
      properties: {
        to: addressArray('Recipient email addresses.'),
        cc: addressArray('CC addresses.'),
        bcc: addressArray('BCC addresses.'),
        subject: { type: 'string', description: 'Subject line.' },
        body: { type: 'string', description: 'Plain-text body of the email.' },
        replyToThreadId: {
          type: 'string',
          description: 'Gmail thread id to reply into, when replying.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    id: GMAIL_DRAFT_UPDATE_TOOL_ID,
    summary: 'Revise an email draft already shown in the chat.',
    label: 'Revise Draft',
    requiresExplicitGrant: true,
    safe: false,
    description:
      'Replace the contents of a draft you previously created. Any edit '
      + 'invalidates an approval already given for it, so the person is asked '
      + 'again before it can be sent.',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: 'The draft id from gmail_draft_create.' },
        to: addressArray('Recipient email addresses.'),
        cc: addressArray('CC addresses.'),
        bcc: addressArray('BCC addresses.'),
        subject: { type: 'string', description: 'Subject line.' },
        body: { type: 'string', description: 'Plain-text body of the email.' },
      },
      required: ['draftId', 'to', 'subject', 'body'],
    },
  },
  {
    id: GMAIL_DRAFT_SEND_TOOL_ID,
    summary: 'Send an email draft as the requesting person.',
    label: 'Send Email',
    requiresExplicitGrant: true,
    // Structural, not a seeded policy row: the evaluator defaults to `allow`,
    // so a data-driven gate is simply absent wherever the seed never ran.
    requiresApproval: true,
    safe: false,
    description:
      'Send a draft you created, as the requesting person. The person is asked '
      + 'to approve before anything leaves, unless they have already granted '
      + 'you standing permission to send on their behalf.',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: 'The draft id from gmail_draft_create.' },
      },
      required: ['draftId'],
    },
  },
  {
    id: CALENDAR_LIST_TOOL_ID,
    summary: "List the requesting person's calendars.",
    label: 'List Calendars',
    requiresExplicitGrant: true,
    safe: true,
    description: 'List the calendars the requesting person can see.',
    parameters: { type: 'object', properties: {} },
  },
  {
    id: CALENDAR_EVENTS_LIST_TOOL_ID,
    summary: "Read events from the requesting person's calendar.",
    label: 'Read Calendar',
    requiresExplicitGrant: true,
    safe: true,
    description:
      'List calendar events in a time range, with title, time, location and '
      + 'attendees.',
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id; defaults to primary.' },
        timeMin: { type: 'string', description: 'ISO 8601 start of the range.' },
        timeMax: { type: 'string', description: 'ISO 8601 end of the range.' },
        query: { type: 'string', description: 'Free-text search within events.' },
      },
    },
  },
  {
    id: CALENDAR_FREEBUSY_TOOL_ID,
    summary: 'Find when people are free.',
    label: 'Check Availability',
    requiresExplicitGrant: true,
    safe: true,
    description:
      'Return busy blocks for the requesting person and any other addresses '
      + 'given, so a meeting time can be proposed. Returns times only — never '
      + 'event titles, guests or notes.',
    parameters: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO 8601 start of the range.' },
        timeMax: { type: 'string', description: 'ISO 8601 end of the range.' },
        attendees: addressArray('Other people whose availability to check.'),
      },
      required: ['timeMin', 'timeMax'],
    },
  },
  {
    id: CALENDAR_EVENT_CREATE_TOOL_ID,
    summary: 'Create a calendar event, optionally with a Google Meet link.',
    label: 'Create Event',
    requiresExplicitGrant: true,
    // Inviting guests sends mail on the person's behalf, so the same gate
    // applies; the handler drops it when there are no attendees.
    requiresApproval: true,
    safe: false,
    description:
      'Create an event on the requesting person’s calendar. Set addMeet to '
      + 'attach a Google Meet link. Inviting attendees emails them, so the '
      + 'person is asked to approve first.',
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id; defaults to primary.' },
        title: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'ISO 8601 start time.' },
        end: { type: 'string', description: 'ISO 8601 end time.' },
        description: { type: 'string', description: 'Event description.' },
        location: { type: 'string', description: 'Event location.' },
        attendees: addressArray('Guest email addresses to invite.'),
        addMeet: {
          type: 'boolean',
          description: 'Attach a Google Meet link to the event.',
        },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    id: CALENDAR_EVENT_UPDATE_TOOL_ID,
    summary: 'Change an existing calendar event.',
    label: 'Update Event',
    requiresExplicitGrant: true,
    requiresApproval: true,
    safe: false,
    description:
      'Change the time, title, description or guests of an existing event. '
      + 'Guests are notified, so the person is asked to approve first.',
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id; defaults to primary.' },
        eventId: { type: 'string', description: 'The event to change.' },
        title: { type: 'string', description: 'New title.' },
        start: { type: 'string', description: 'New ISO 8601 start time.' },
        end: { type: 'string', description: 'New ISO 8601 end time.' },
        description: { type: 'string', description: 'New description.' },
        location: { type: 'string', description: 'New location.' },
        attendees: addressArray('Replacement guest list.'),
      },
      required: ['eventId'],
    },
  },
  {
    id: CALENDAR_EVENT_CANCEL_TOOL_ID,
    summary: 'Cancel a calendar event.',
    label: 'Cancel Event',
    requiresExplicitGrant: true,
    requiresApproval: true,
    safe: false,
    description:
      'Cancel an event. Guests are notified, so the person is asked to approve '
      + 'first.',
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id; defaults to primary.' },
        eventId: { type: 'string', description: 'The event to cancel.' },
      },
      required: ['eventId'],
    },
  },
]

/** Tool ids whose approval requirement is declared in code, not in policy data. */
export const STRUCTURALLY_APPROVAL_GATED_TOOL_IDS = new Set(
  GOOGLE_TOOL_DEFINITIONS
    .filter((tool) => tool.requiresApproval)
    .map((tool) => tool.id),
)
