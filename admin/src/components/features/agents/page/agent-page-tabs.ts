import type { TabBarItem } from '../../../primitives/TabBar'
import type { DesignerPageContext } from '../../../../facades/designer/types'
import type { AgentRecord } from '../../../../lib/api-client'

/**
 * The agent page's six tabs (docs/plans/2026-09-26-admin-ux-overhaul.md §6.3):
 * what it is, what it is told, what it may use, what wakes it, what it has
 * done, and how it is set up. One strip, in the URL as `?tab=`, for every
 * reader — a manager edits in place, anybody else reads the same tabs.
 */
export const AGENT_PAGE_TABS = [
  'about',
  'instructions',
  'access',
  'schedule',
  'activity',
  'settings',
] as const
export type AgentPageTab = (typeof AGENT_PAGE_TABS)[number]

export const AGENT_PAGE_TAB_LABELS: Record<AgentPageTab, string> = {
  about: 'About',
  access: 'Access',
  activity: 'Activity',
  instructions: 'Instructions',
  schedule: 'Schedule',
  settings: 'Settings',
}

/**
 * A built-in agent's operational reads — status, activity, conversations,
 * to-dos, documents, its mailbox, its schedules — are closed to everybody
 * (`isAgentAccessibleToActor` answers them with a 404), and a schedule may
 * never target one. So it gets the tabs that resolve from the entitled agent
 * list alone, rendered like any other agent's with nothing to change, and not
 * the two that could only ever report a failure.
 */
const BUILT_IN_TABS: readonly AgentPageTab[] = ['about', 'instructions', 'access', 'settings']

export const isBuiltInAgent = (agent: Pick<AgentRecord, 'systemManaged'>): boolean =>
  agent.systemManaged === true

export const agentPageTabs = (agent: Pick<AgentRecord, 'systemManaged'>): readonly AgentPageTab[] =>
  isBuiltInAgent(agent) ? BUILT_IN_TABS : AGENT_PAGE_TABS

export const agentPageTabItems = (
  tabs: readonly AgentPageTab[],
): ReadonlyArray<TabBarItem<AgentPageTab>> =>
  tabs.map((tab) => ({ label: AGENT_PAGE_TAB_LABELS[tab], value: tab }))

/**
 * Where each Design Assistant tool's control lives. The page shows that tab
 * before the assistant changes it, so a change is never made to a form the
 * person cannot see — the reason the old designer refused them outright on
 * any other tab.
 */
export const ASSISTANT_TOOL_TABS: Readonly<Record<string, AgentPageTab>> = {
  batch_toggle_tools: 'access',
  set_model: 'settings',
  set_name: 'settings',
  set_role: 'settings',
  set_system_prompt: 'instructions',
  set_tool_selection: 'access',
  toggle_tool: 'access',
}

/** The tool toggles, which an existing agent's Access tab writes itself. */
export const isAssistantToolToggle = (name: string): boolean =>
  ASSISTANT_TOOL_TABS[name] === 'access'

const EDITABLE_CONTROLS = [
  'change the name, role and model (Settings)',
  'rewrite the instructions (Instructions)',
  'turn tools on or off (Access), which the person then saves',
]

const DESCRIPTIONS: Record<AgentPageTab, string> = {
  about: 'What this agent is, where it works, and anything about it that needs attention.',
  access: 'The tools, apps, cloud browser and email address this agent may use.',
  activity: 'Its conversations, its current run, its to-dos, and the runs that failed.',
  instructions: 'Its instructions, how it talks to people, its documents, and its checklists.',
  schedule: 'Everything that wakes this agent: schedules, intervals, board columns and document watches.',
  settings: 'Its name, role, model, effort, run limits, voice, ownership and to-dos.',
}

/**
 * What the assistant is told about the screen. Every tab offers the same
 * controls, because the page switches to the tab that holds the one being
 * changed.
 */
export const agentPageAssistantContext = (tab: AgentPageTab): DesignerPageContext => ({
  actions: EDITABLE_CONTROLS,
  description: DESCRIPTIONS[tab],
  title: `${AGENT_PAGE_TAB_LABELS[tab]} tab of the agent page`,
})

/** The create flow's context: the whole form is on one screen. */
export const NEW_AGENT_ASSISTANT_CONTEXT: DesignerPageContext = {
  actions: [
    'set the name, role and model',
    'write the instructions',
    'choose its tools',
  ],
  description: 'A new agent, not saved yet. Create agent saves it.',
  title: 'New agent',
}
