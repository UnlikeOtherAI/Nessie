import type { BuiltinToolDefinition } from './builtin-tools-types.js'

const UUID = { type: 'string', description: 'The UUID returned by a resolving tool.' } as const
// Optional on every tool a shared agent can be lent: it is lent them only in
// its own project channel, where the project is already known, and it holds no
// project_list to resolve one with. One definition serves both callers, so the
// description says which one may omit it: the Personal Assistant works across
// projects and is never defaulted (`ticketProjectIdFor`), not even in a
// project channel it has joined.
const PROJECT_ID = { type: 'string', description: 'The project’s UUID. An agent working in its own project channel omits it and gets that channel’s project. The Personal Assistant always names it, from project_list.' } as const
const LABEL_IDS = { type: 'array', items: { type: 'string' }, description: 'The ticket’s whole label set, as label UUIDs of the ticket’s board from ticket_labels_read; an empty list clears it.' } as const
const MARKDOWN = 'Ticket descriptions (detail) and comments are Markdown. To show an image inline, upload it with attachment_upload, attach it with ticket_attachment_add, and write ![alt](/api/attachments/<attachmentId>).'

/**
 * Project ticket operations for a person's delegated Personal Assistant.
 * There is deliberately no hard delete: the board's reversible equivalent is
 * `ticket_transition` to `cancelled`, followed by `inbox` to restore it.
 */
export const TICKET_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'ticket_list', category: 'projects', label: 'List Tickets', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'List tickets in one project.', safe: true,
    description: 'List tickets in one project: this channel’s project when projectId is omitted.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID, status: { type: 'string', description: 'Optional ticket status.' } }, required: [] },
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
    id: 'ticket_read', category: 'projects', label: 'Read Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Read one ticket after resolving its ID.', safe: true,
    description: `Read a ticket returned by ticket_list: its full detail, current assignment, labels, where it originates, and how many files and comments it has (read those with ticket_attachment_list and ticket_comment_list). ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_checklist_read', category: 'projects', label: 'Read Ticket Checklist', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Read the reusable-checklist snapshot on one ticket.', safe: true,
    description: 'Read the checklist applied to a ticket, including each step’s instructions, completion and recorded result.',
    parameters: { type: 'object', properties: { ticketId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_checklist_apply', category: 'projects', label: 'Apply Ticket Checklist', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Apply one of this agent’s active reusable templates to a ticket.', safe: false,
    description: 'Copy one of this agent’s active templates onto an accessible ticket. The ticket keeps a task-owned snapshot, so later template edits do not change recorded work. Applying again preserves the existing checklist and its results.',
    parameters: { type: 'object', properties: { ticketId: UUID, templateId: UUID }, required: ['ticketId', 'templateId'] },
  },
  {
    id: 'ticket_checklist_step_update', category: 'projects', label: 'Update Ticket Checklist Step', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Complete or reopen one checklist step and record its result.', safe: false,
    description: 'Update a step returned by ticket_checklist_read. Set result to null to clear a previous result; omit result to keep it.',
    parameters: { type: 'object', properties: { ticketId: UUID, stepKey: { type: 'string' }, completed: { type: 'boolean' }, result: { type: ['string', 'null'] } }, required: ['ticketId', 'stepKey', 'completed'] },
  },
  {
    id: 'ticket_board_read', category: 'projects', label: 'Read Ticket Board', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'List a project’s boards and their columns.', safe: true,
    description: 'Read a project’s boards before ticket_create or ticket_move. Each board owns its own tickets and columns; use a returned boardId or columnId, and do not guess UUIDs.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID }, required: [] },
  },
  {
    id: 'ticket_create', category: 'projects', label: 'Create Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Create a ticket in an accessible project.', safe: false,
    description: `Create a project ticket. It is owned by the user and can be assigned to one person or agent. Give a boardId from ticket_board_read to put it on a particular board; without one it lands on the project’s default board. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { projectId: PROJECT_ID, boardId: UUID, title: { type: 'string' }, purpose: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, dueDate: { type: 'string', description: 'ISO date or timestamp.' }, assigneeUserId: UUID, assigneeAgentId: UUID, labelIds: LABEL_IDS }, required: ['title'] },
  },
  {
    id: 'ticket_update', category: 'projects', label: 'Update Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Edit a ticket’s fields.', safe: false,
    description: `Update one or more ticket fields. Use ticket_read first when you need its current values. labelIds replaces the whole label set. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID, title: { type: 'string' }, purpose: { type: ['string', 'null'] }, detail: { type: ['string', 'null'] }, labelIds: LABEL_IDS, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, dueDate: { type: ['string', 'null'] }, storyPoints: { type: ['integer', 'null'] }, fieldValues: { type: 'object', description: 'Custom field values keyed by the field UUID from ticket_fields_read. A value of null clears that field.', additionalProperties: true } }, required: ['ticketId'] },
  },
  {
    id: 'ticket_labels_read', category: 'projects', label: 'Read Ticket Labels', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'List a board’s labels and their IDs.', safe: true,
    description: 'Read a board’s labels before setting labelIds with ticket_create or ticket_update. A ticket’s labels are the labels of the board it is on (ticket_read names it). With boardId, that board’s labels; without, every board’s, grouped by board. Each line gives the labelId to use; do not guess them. A label an external source (Linear, Jira, GitHub, Trello) owns says so.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID, boardId: UUID }, required: [] },
  },
  {
    id: 'ticket_label_create', category: 'projects', label: 'Create Ticket Label', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Add a label to a board.', safe: false,
    description: 'Create a label on a board: boardId’s, or the project’s default board when it is omitted. If the name is already taken on that board (ignoring case), the existing label is returned instead; use it. color is #rrggbb and optional.',
    parameters: { type: 'object', properties: { projectId: PROJECT_ID, boardId: UUID, name: { type: 'string' }, color: { type: 'string', description: '#rrggbb' } }, required: ['name'] },
  },
  {
    id: 'ticket_comment_list', category: 'projects', label: 'Read Ticket Comments', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Read the comments on one ticket.', safe: true,
    description: `Read a ticket’s comments, oldest first. Each says whether a person, an agent or someone in an external system wrote it, with their id; pass nextCursor back as cursor for more. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['ticketId'] },
  },
  {
    id: 'ticket_comment_add', category: 'projects', label: 'Comment on Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Add a comment to a ticket.', safe: false,
    description: `Add a comment to a ticket. On a ticket mirrored from an external system with read & write access it is posted there too; otherwise it stays in Nessie and the result says so. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID, body: { type: 'string' } }, required: ['ticketId', 'body'] },
  },
  {
    id: 'ticket_comment_update', category: 'projects', label: 'Edit Ticket Comment', personalAssistantOnly: true,
    summary: 'Change the text of a comment you wrote.', safe: false,
    description: `Change a comment’s text. Only its author can change a comment; take the commentId from ticket_comment_list. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID, commentId: UUID, body: { type: 'string' } }, required: ['ticketId', 'commentId', 'body'] },
  },
  {
    id: 'ticket_comment_delete', category: 'projects', label: 'Delete Ticket Comment', personalAssistantOnly: true,
    summary: 'Delete a comment you wrote.', safe: false,
    description: 'Delete a comment; its files are marked removed and stay downloadable. Only its author can delete a comment; take the commentId from ticket_comment_list.',
    parameters: { type: 'object', properties: { ticketId: UUID, commentId: UUID }, required: ['ticketId', 'commentId'] },
  },
  {
    id: 'ticket_attachment_list', category: 'projects', label: 'Read Ticket Files', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'List the files on one ticket.', safe: true,
    description: 'List a ticket’s files, newest first, with the attachmentId to read one with attachment_read. Files an external system keeps are listed as links; a removed file says who removed it, when and why, and can still be read.',
    parameters: { type: 'object', properties: { ticketId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_attachment_add', category: 'projects', label: 'Attach File to Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Attach an uploaded file to a ticket.', safe: false,
    description: `Attach a file this conversation uploaded with attachment_upload (and has not yet sent) to a ticket. ${MARKDOWN}`,
    parameters: { type: 'object', properties: { ticketId: UUID, attachmentId: UUID }, required: ['ticketId', 'attachmentId'] },
  },
  {
    id: 'ticket_attachment_remove', category: 'projects', label: 'Remove Ticket File', personalAssistantOnly: true,
    summary: 'Mark a file on a ticket as removed.', safe: false,
    description: 'Mark a file on a ticket as removed. It stays downloadable and the ticket shows who removed it and why; give a reason when you have one (at most 500 characters). Take the attachmentId from ticket_attachment_list.',
    parameters: { type: 'object', properties: { ticketId: UUID, attachmentId: UUID, reason: { type: 'string', maxLength: 500 } }, required: ['ticketId', 'attachmentId'] },
  },
  {
    id: 'ticket_fields_read', category: 'projects', label: 'Read Ticket Fields', personalAssistantOnly: true,
    summary: 'List a project’s custom ticket fields and their option IDs.', safe: true,
    description: 'Read a project’s custom field definitions before setting fieldValues with ticket_update. Select fields answer with the option IDs to use; do not guess them.',
    parameters: { type: 'object', properties: { projectId: UUID }, required: ['projectId'] },
  },
  {
    id: 'ticket_assign', category: 'projects', label: 'Assign Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Assign a ticket to a person or agent.', safe: false,
    description: 'Assign one ticket to a user or agent. Omitting both clears its assignment.',
    parameters: { type: 'object', properties: { ticketId: UUID, assigneeUserId: UUID, assigneeAgentId: UUID }, required: ['ticketId'] },
  },
  {
    id: 'ticket_move', category: 'projects', label: 'Move Ticket', personalAssistantOnly: true, projectDelegatedOnly: true,
    summary: 'Move a ticket to a board column.', safe: false,
    description: 'Move or reorder a ticket with a columnId from ticket_board_read. A columnId on another board moves the ticket to that board.',
    parameters: { type: 'object', properties: { ticketId: UUID, columnId: UUID, position: { type: 'integer', minimum: 0 } }, required: ['ticketId', 'columnId'] },
  },
  {
    id: 'ticket_transition', category: 'projects', label: 'Change Ticket Status', personalAssistantOnly: true, projectDelegatedOnly: true,
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

export const TICKET_BOARD_CREATE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'ticket_board_create', category: 'projects', label: 'Create Ticket Board',
  personalAssistantOnly: true, projectDelegatedOnly: true, requiresExplicitGrant: true,
  summary: 'Create a board in the current project.', safe: false,
  description: 'Create a board in the project this conversation belongs to. Requires a live member of the project (or an organisation owner or admin) or their bounded peer delegation.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, iconEmoji: { type: ['string', 'null'] }, style: { type: 'string', enum: ['kanban', 'scrum'] } }, required: ['name'] },
}
