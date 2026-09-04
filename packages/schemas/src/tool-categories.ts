import { z } from 'zod'

/**
 * What a tool is *for*, declared by the tool and rendered by every surface
 * that lists tools.
 *
 * Before this, the admin guessed a tool's category from its id prefix
 * (`file_`, `web_`, `kb_`…) and swept everything unmatched into one
 * "Agent & team" bucket. That bucket held 75 of 116 builtins: a new tool
 * joined it by default, and the only way out was to invent another prefix
 * rule. Category is therefore a **required** field on `BuiltinToolDefinition`
 * — adding a tool without choosing where it belongs does not compile, which is
 * what keeps the dumping ground from re-forming.
 *
 * A category is a place a person would go looking, not an implementation
 * detail: "where do I turn off email?" has an answer, "which tools start with
 * `gmail_`?" does not.
 */
export const TOOL_CATEGORIES = [
  {
    description: 'Reading, writing and reacting to messages.',
    id: 'conversation',
    label: 'Conversation',
  },
  {
    description: 'Finding, joining and administering channels.',
    id: 'channels',
    label: 'Channels',
  },
  {
    description: 'Reading and writing the knowledge base, its documents and comments.',
    id: 'knowledge',
    label: 'Knowledge base',
  },
  {
    description: 'Reading and writing files and message attachments.',
    id: 'files',
    label: 'Files & attachments',
  },
  {
    description: 'Searching and fetching from the public web, and deep research.',
    id: 'web',
    label: 'Web & research',
  },
  {
    description: 'Driving a real browser on a page.',
    id: 'browser',
    label: 'Browser',
  },
  {
    description: 'Reading and writing the person’s mailbox, calendar and contacts.',
    id: 'email-calendar',
    label: 'Email & calendar',
  },
  {
    // Deliberately separate from `email-calendar`: that acts as the *person*
    // through their connected account, this acts as the *agent* at its own
    // address. Turning one off is a different decision from turning the other
    // off, so they are different places to go looking.
    description: 'Sending and reading mail at the agent’s own address.',
    id: 'agent-mailbox',
    label: 'Agent mailbox',
  },
  {
    description: 'Creating meeting links and ringing a channel.',
    id: 'calls',
    label: 'Calls',
  },
  {
    description: 'Running work later, or on a repeating schedule.',
    id: 'scheduling',
    label: 'Schedules & triggers',
  },
  {
    description: 'Keeping and advancing a tracked checklist.',
    id: 'todos',
    label: 'To-dos',
  },
  {
    description: 'Creating projects and managing the tickets on their boards.',
    id: 'projects',
    label: 'Projects & tickets',
  },
  {
    description: 'Creating agents, binding them to channels, and delegating work.',
    id: 'agents',
    label: 'Agents & delegation',
  },
  {
    description: 'Installing and authorising third-party apps and connectors.',
    id: 'apps',
    label: 'Apps & connectors',
  },
  {
    description: 'Pairing and controlling machines that run work locally.',
    id: 'executors',
    label: 'Executors',
  },
  {
    description: 'Building and reading dashboards and their widgets.',
    id: 'dashboards',
    label: 'Dashboards',
  },
  {
    description: 'Recording, previewing and carrying state through workflows.',
    id: 'workflows',
    label: 'Workflows',
  },
  {
    description: 'Searching the team directory and changing preferences.',
    id: 'team',
    label: 'People & team',
  },
] as const

export type ToolCategory = (typeof TOOL_CATEGORIES)[number]
export type ToolCategoryId = ToolCategory['id']

export const TOOL_CATEGORY_IDS = TOOL_CATEGORIES.map((category) => category.id)

export const ToolCategoryIdSchema = z.enum(
  TOOL_CATEGORY_IDS as unknown as [ToolCategoryId, ...ToolCategoryId[]],
)

const BY_ID = new Map<string, ToolCategory>(
  TOOL_CATEGORIES.map((category) => [category.id, category]),
)

export const findToolCategory = (id: string): ToolCategory | undefined => BY_ID.get(id)
