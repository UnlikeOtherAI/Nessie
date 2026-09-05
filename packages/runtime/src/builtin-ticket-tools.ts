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
    id: 'ticket_read', category: 'projects', label: 'Read Ticket', personalAssistantOnly: true,
    summary: 'Read one ticket after resolving its ID.', safe: true,
    description: 'Read a ticket returned by ticket_list, including its full detail and current assignment.',
    parameters: { type: 'object', properties: { ticketId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_board_read', category: 'projects', label: 'Read Ticket Board', personalAssistantOnly: true,
    summary: 'List a project’s boards and their columns.', safe: true,
    description: 'Read a project’s boards before ticket_move. A project can have several boards over the same tickets; use a returned columnId, and do not guess UUIDs.',
    parameters: { type: 'object', properties: { projectId: UUID }, required: ['projectId'] },
  },
  {
    id: 'ticket_create', category: 'projects', label: 'Create Ticket', personalAssistantOnly: true,
    summary: 'Create a ticket in an accessible project.', safe: false,
    description: 'Create a project ticket. It is owned by the user and can be assigned to one person or agent.',
    parameters: { type: 'object', properties: { projectId: UUID, title: { type: 'string' }, purpose: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, dueDate: { type: 'string', description: 'ISO date or timestamp.' }, assigneeUserId: UUID, assigneeAgentId: UUID }, required: ['projectId', 'title'] },
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
    description: 'Move or reorder a ticket with a columnId from ticket_board_read.',
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
