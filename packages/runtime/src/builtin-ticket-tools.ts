import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const UUID = { type: 'string', description: 'The UUID returned by a resolving tool.' } as const

/**
 * Project ticket operations for a person's delegated Personal Assistant.
 * There is deliberately no hard delete: the board's reversible equivalent is
 * `ticket_transition` to `cancelled`, followed by `inbox` to restore it.
 */
export const TICKET_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'ticket_list', category: 'projects', label: 'List Tickets', personalAssistantOnly: true,
    summary: 'List tickets in one project.', safe: true,
    description: 'List tickets in one project. Resolve projectId with project_list first.',
    parameters: { type: 'object', properties: { projectId: UUID, status: { type: 'string', description: 'Optional ticket status.' } }, required: ['projectId'] },
  },
  {
    id: 'ticket_search', category: 'projects', label: 'Search Tickets', personalAssistantOnly: true,
    summary: 'Search tickets across projects.', safe: true,
    description: 'Search tickets by text and narrow by project, board, status, priority or assignee. Text matches the title, purpose, detail and the provider key of a mirrored ticket (for example ENG-214). Use assigneeUserId for a colleague; use unmappedAssignee for somebody who works in Jira, Linear, Trello or GitHub but has no Nessie account — resolve them with ticket_people_read. Omit every filter but text to search everything you can reach.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Words to look for. Omit to list by filter alone.' }, projectId: UUID, boardId: UUID, status: { type: 'string', description: 'Optional ticket status.' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, assigneeUserId: UUID, unmappedAssignee: { type: 'string', description: 'A provider person with no Nessie account, by the externalUserId or displayName from ticket_people_read.' }, unassigned: { type: 'boolean', description: 'Only tickets nobody at all is on.' }, includeArchived: { type: 'boolean' }, limit: { type: 'integer', description: 'Up to 200; 50 by default.' } }, required: [] },
  },
  {
    id: 'ticket_search_remote', category: 'projects', label: 'Search Provider Tickets', personalAssistantOnly: true,
    summary: 'Search connected Jira, Linear, Trello and GitHub live.', safe: true,
    description: 'Search the connected Jira, Linear, Trello and GitHub sources directly, for work Nessie has not mirrored — an item outside the sync window, in a state the board does not map, or newer than the last sync. Use ticket_search first: it covers everything already mirrored and is what you can act on. Results say which items exist in Nessie and which do not; an item that does not cannot be updated, moved or assigned until it syncs.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Words to search the provider for.' }, projectId: UUID, limit: { type: 'integer', description: 'Up to 25.' } }, required: ['text'] },
  },
  {
    id: 'ticket_people_read', category: 'projects', label: 'Read Ticket People', personalAssistantOnly: true,
    summary: 'List who can hold a ticket, mapped or not.', safe: true,
    description: 'List the people tickets can be attributed to: colleagues with a Nessie account, and the Jira, Linear, Trello or GitHub users a mirrored ticket names that Nessie has no account for. Use it to turn a name into the assigneeUserId or unmappedAssignee that ticket_search takes.',
    parameters: { type: 'object', properties: { projectId: UUID }, required: [] },
  },
  {
    id: 'ticket_read', category: 'projects', label: 'Read Ticket', personalAssistantOnly: true,
    summary: 'Read one ticket after resolving its ID.', safe: true,
    description: 'Read a ticket returned by ticket_list, including its full detail and current assignment.',
    parameters: { type: 'object', properties: { ticketId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_board_read', category: 'projects', label: 'Read Ticket Board', personalAssistantOnly: true,
    summary: 'List a project’s boards and their columns.', safe: true,
    description: 'Read a project’s boards before ticket_create or ticket_move. Each board owns its own tickets and columns; use a returned boardId or columnId, and do not guess UUIDs.',
    parameters: { type: 'object', properties: { projectId: UUID }, required: ['projectId'] },
  },
  {
    id: 'ticket_create', category: 'projects', label: 'Create Ticket', personalAssistantOnly: true,
    summary: 'Create a ticket in an accessible project.', safe: false,
    description: 'Create a project ticket. It is owned by the user and can be assigned to one person or agent. Give a boardId from ticket_board_read to put it on a particular board; without one it lands on the project’s default board.',
    parameters: { type: 'object', properties: { projectId: UUID, boardId: UUID, title: { type: 'string' }, purpose: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, dueDate: { type: 'string', description: 'ISO date or timestamp.' }, assigneeUserId: UUID, assigneeAgentId: UUID }, required: ['projectId', 'title'] },
  },
  {
    id: 'ticket_update', category: 'projects', label: 'Update Ticket', personalAssistantOnly: true,
    summary: 'Edit a ticket’s fields.', safe: false,
    description: 'Update one or more ticket fields. Use ticket_read first when you need its current values.',
    parameters: { type: 'object', properties: { ticketId: UUID, title: { type: 'string' }, purpose: { type: ['string', 'null'] }, detail: { type: ['string', 'null'] }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, dueDate: { type: ['string', 'null'] }, storyPoints: { type: ['integer', 'null'] }, fieldValues: { type: 'object', description: 'Custom field values keyed by the field UUID from ticket_fields_read. A value of null clears that field.', additionalProperties: true } }, required: ['ticketId'] },
  },
  {
    id: 'ticket_fields_read', category: 'projects', label: 'Read Ticket Fields', personalAssistantOnly: true,
    summary: 'List a project’s custom ticket fields and their option IDs.', safe: true,
    description: 'Read a project’s custom field definitions before setting fieldValues with ticket_update. Select fields answer with the option IDs to use; do not guess them.',
    parameters: { type: 'object', properties: { projectId: UUID }, required: ['projectId'] },
  },
  {
    id: 'ticket_assign', category: 'projects', label: 'Assign Ticket', personalAssistantOnly: true,
    summary: 'Assign a ticket to a person or agent.', safe: false,
    description: 'Assign one ticket to a user or agent. Omitting both clears its assignment.',
    parameters: { type: 'object', properties: { ticketId: UUID, assigneeUserId: UUID, assigneeAgentId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_move', category: 'projects', label: 'Move Ticket', personalAssistantOnly: true,
    summary: 'Move a ticket to a board column.', safe: false,
    description: 'Move or reorder a ticket with a columnId from ticket_board_read. A columnId on another board moves the ticket to that board.',
    parameters: { type: 'object', properties: { ticketId: UUID, columnId: UUID, position: { type: 'integer', minimum: 0 } }, required: ['ticketId', 'columnId'] },
  },
  {
    id: 'ticket_transition', category: 'projects', label: 'Change Ticket Status', personalAssistantOnly: true,
    summary: 'Change a ticket’s workflow status.', safe: false,
    description: 'Change ticket status. Set status to cancelled to remove it from the board; set a cancelled ticket to inbox to restore it.',
    parameters: { type: 'object', properties: { ticketId: UUID, status: { type: 'string', enum: ['inbox', 'assigned', 'in_progress', 'review', 'done', 'failed', 'cancelled', 'awaiting_approval'] } }, required: ['ticketId', 'status'] },
  },
  {
    id: 'ticket_iteration_set', category: 'projects', label: 'Set Ticket Iteration', personalAssistantOnly: true,
    summary: 'Add or remove a ticket from a sprint iteration.', safe: false,
    description: 'Set a ticket’s iteration UUID, or null to move it back to the backlog.',
    parameters: { type: 'object', properties: { ticketId: UUID, iterationId: { type: ['string', 'null'] } }, required: ['ticketId', 'iterationId'] },
  },
  {
    id: 'ticket_archive_done', category: 'projects', label: 'Archive Completed Tickets', personalAssistantOnly: true,
    summary: 'Archive completed tickets from one project.', safe: false,
    description: 'Archive completed tickets in one explicit project, optionally only tickets untouched for the given days.',
    parameters: { type: 'object', properties: { projectId: UUID, olderThanDays: { type: 'integer', minimum: 1 } }, required: ['projectId'] },
  },
]
