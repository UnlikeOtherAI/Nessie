import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * The project-operator capability: an ordinary agent (a CTO, say) setting up
 * new projects and flows for the live person talking to it
 * (docs/standards/personal-assistant-tools.md → "The project-operator
 * capability"; docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md).
 *
 * `project_operator` is ONE explicit grant, not a tool anybody calls. It is a
 * registry entry like every other explicit-grant builtin — which is what puts
 * it on the agent's Tools page, in `agent_tool_access_inspect`, behind the
 * protected-key gate generic updates are refused by, and in the owner's and
 * the Designer's one grant writer — but it lives in
 * `CAPABILITY_GRANT_DEFINITIONS`, outside `BUILTIN_TOOL_DEFINITIONS`, so no
 * run is ever offered it as a function. What it opens is every definition
 * flagged `projectOperator`, through the third `personalAssistantOnly` arm in
 * `worker/src/run/tool-policy.ts`, and only on a live-requester run.
 */
export const PROJECT_OPERATOR_CAPABILITY_ID = 'project_operator'

const ACTS_AS = 'It acts as the person asking you, with exactly their rights, and is refused where they would be.'

export const PROJECT_OPERATOR_CAPABILITY_DEFINITION: BuiltinToolDefinition = {
  id: PROJECT_OPERATOR_CAPABILITY_ID,
  category: 'projects',
  label: 'Project operator',
  summary: 'Set up projects and flows for the person talking to it, as that person.',
  // What the Tools page shows beside the switch, most important first: the
  // row folds after two lines, and who it acts as is the decision it drives.
  description:
    'Acts as the person talking to it, with exactly their rights, while they talk to it in a '
    + 'project channel it is in — never on a trigger, a schedule or ticket work. It can then set up '
    + 'projects, channels, boards with their columns and labels, document spaces, triggers for itself '
    + 'or agents in its project, and workflows: nothing that person could not do themselves. It never '
    + 'changes who is in a project and never sets up machine access.',
  parameters: { type: 'object', properties: {} },
  requiresExplicitGrant: true,
  safe: false,
}

/**
 * Explicit grants that are capabilities rather than callable tools. Registered
 * and protected exactly like an explicit-grant builtin (they are part of
 * `SYSTEM_TOOL_DEFINITIONS`), never offered to a model (they are not part of
 * `BUILTIN_TOOL_DEFINITIONS`, which is the only set a run's toolset is built
 * from).
 */
export const CAPABILITY_GRANT_DEFINITIONS: BuiltinToolDefinition[] = [PROJECT_OPERATOR_CAPABILITY_DEFINITION]

const UUID = { type: 'string' } as const
const COLUMN_CATEGORY = {
  type: 'string',
  enum: ['todo', 'in_progress', 'review', 'done'],
  description: 'What a ticket in this column is: todo, in_progress, review or done.',
} as const

/**
 * The operator verbs with no earlier tool. Each mirrors its route's
 * authorization (`POST`/`PATCH /api/projects/:projectId/boards/:boardId/columns`
 * are `requireProjectModifier`; `POST /api/knowledge-base/spaces` needs a
 * project the person belongs to), acting as the live requester. They are not
 * `identityDelegatedOnly`, so the Personal Assistant and the Agent Designer
 * reach them through their own arms too.
 */
export const PROJECT_OPERATOR_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'ticket_board_column_create',
    category: 'projects',
    label: 'Add Board Column',
    personalAssistantOnly: true,
    projectOperator: true,
    summary: 'Add a column to a board.',
    description:
      `Add a column to a board, with its category. ${ACTS_AS} Any member of the board's project may do `
      + 'this, like in Board settings. Take the boardId from ticket_board_read or the board you just made. '
      + 'The column goes last unless you give a position (0 is first).',
    parameters: {
      type: 'object',
      properties: {
        boardId: { ...UUID, description: 'The board to add the column to.' },
        name: { type: 'string', description: 'The column name, e.g. "In review".' },
        category: COLUMN_CATEGORY,
        position: { type: 'integer', minimum: 0, description: 'Optional: where it goes, 0 being first.' },
      },
      required: ['boardId', 'name', 'category'],
    },
    safe: false,
  },
  {
    id: 'ticket_board_column_update',
    category: 'projects',
    label: 'Change Board Column',
    personalAssistantOnly: true,
    projectOperator: true,
    summary: 'Rename, recategorise or move a board column.',
    description:
      `Change a board column: its name, its category or its position. ${ACTS_AS} Any member of the `
      + 'board\'s project may do this, like in Board settings. Take the columnId from ticket_board_read.',
    parameters: {
      type: 'object',
      properties: {
        boardId: { ...UUID, description: 'The board the column is on.' },
        columnId: { ...UUID, description: 'The column to change.' },
        name: { type: 'string', description: 'Optional: its new name.' },
        category: { ...COLUMN_CATEGORY, description: `Optional: its new category. ${COLUMN_CATEGORY.description}` },
        position: { type: 'integer', minimum: 0, description: 'Optional: its new position, 0 being first.' },
      },
      required: ['boardId', 'columnId'],
    },
    safe: false,
  },
  {
    id: 'kb_space_create',
    category: 'knowledge',
    label: 'Create Document Space',
    personalAssistantOnly: true,
    projectOperator: true,
    summary: 'Create a project\'s documents space, or a named document space in a project.',
    description:
      `Create a place for a project's documents. ${ACTS_AS} kind "project_documents" makes sure the `
      + 'project has its shared Project Documents space (it answers with the existing one when there is '
      + 'one); kind "space" makes a new named space every member of the project can read, for example '
      + '"Tech docs". Only a member of the project can do either. projectId is the project, from '
      + 'project_list or a /projects/… link; omit it for the project of this channel.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['project_documents', 'space'] },
        projectId: { ...UUID, description: 'Optional: the project; omitted, this channel\'s.' },
        name: { type: 'string', description: 'The new space\'s name (kind "space" only).' },
        description: { type: 'string', description: 'Optional: what the space is for (kind "space" only).' },
      },
      required: ['kind'],
    },
    safe: false,
  },
]
