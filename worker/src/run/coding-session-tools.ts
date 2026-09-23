import type { ExecutorCodingAgentName, ExecutorCodingSessionsFacts } from '@nessie/schemas'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

/**
 * The agent's first-class coding-session tools
 * (docs/plans/2026-09-22-executor-local-apps/coding-sessions.md §8).
 *
 * A run bound to a revision whose descriptor offers the `coding-sessions`
 * bridge, on a private executor its pairing owner launched, gets these seven
 * instead of reaching the bridge through `executor_mcp_call`. Their
 * descriptions are system text, not a program's catalog the untrusted banner
 * disowns, and their schemas are real, so scalar coercion works. Each one is
 * an `mcp.call` to one bridge tool underneath (`executor/src/coding-session/
 * bridge-tools.ts`), through the same executor toolset — timing, the owner
 * stamp, the disclosure stamp and the ToolCall rows all apply as they do to
 * any other call.
 */

export const CODING_SESSION_TOOL_NAMES = {
  close: 'coding_session_close',
  interrupt: 'coding_session_interrupt',
  list: 'coding_session_list',
  review: 'coding_session_review',
  send: 'coding_session_send',
  start: 'coding_session_start',
  wait: 'coding_session_wait',
} as const

export type CodingSessionToolName = typeof CODING_SESSION_TOOL_NAMES[keyof typeof CODING_SESSION_TOOL_NAMES]

export const CODING_SESSION_TOOL_NAME_SET: ReadonlySet<string> = new Set(Object.values(CODING_SESSION_TOOL_NAMES))

export const isCodingSessionToolName = (name: string): name is CodingSessionToolName =>
  CODING_SESSION_TOOL_NAME_SET.has(name)

/** The bridge tool each one calls: `coding_session_wait` polls `session_status`. */
export const CODING_BRIDGE_TOOL: Record<CodingSessionToolName, string> = {
  coding_session_close: 'session_close',
  coding_session_interrupt: 'session_interrupt',
  coding_session_list: 'session_list',
  coding_session_review: 'session_review',
  coding_session_send: 'session_send',
  coding_session_start: 'session_start',
  coding_session_wait: 'session_status',
}

/** Each agent's name as a person knows it. */
export const CODING_AGENT_LABELS: Record<ExecutorCodingAgentName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

// The bridge's own bounds (`bridge-tools.ts`), repeated so the model is told
// them before the machine refuses them.
const TEXT_MAX = 32_000
const PATH_MAX = 1_000
const TITLE_MAX = 120
const SESSION_ID = {
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  type: 'string',
}

const sessionOnly = {
  additionalProperties: false,
  properties: { sessionId: SESSION_ID },
  required: ['sessionId'],
  type: 'object',
}

/** Claude Code when the machine offers it, which is the agent a bare start gets. */
export const defaultCodingAgent = (facts: ExecutorCodingSessionsFacts): ExecutorCodingAgentName =>
  facts.agents.includes('claude') ? 'claude' : facts.agents[0]!

const agentPhrase = (facts: ExecutorCodingSessionsFacts): string => {
  const primary = defaultCodingAgent(facts)
  const others = facts.agents.filter((agent) => agent !== primary)
  return others.length === 0
    ? CODING_AGENT_LABELS[primary]
    : `${CODING_AGENT_LABELS[primary]} (or ${others.map((agent) => `${CODING_AGENT_LABELS[agent]}, with agent "${agent}"`).join(', ')})`
}

/** The seven descriptors, the start tool's folders and agents taken from the reviewed facts. */
export const codingSessionDescriptors = (facts: ExecutorCodingSessionsFacts): ToolSchemaDescriptor[] => {
  const roots = facts.rootNames.join(', ')
  return [
    {
      toolName: CODING_SESSION_TOOL_NAMES.close,
      description: 'Close only when the work is merged or abandoned, or the person asks. Do not close because your '
        + 'own turn is ending; the session keeps its history and can be resumed.',
      inputSchema: sessionOnly,
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.interrupt,
      description: 'Stop the coding agent\'s current turn. The session stays open and can be sent a new message.',
      inputSchema: sessionOnly,
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.list,
      description: `Roots, agents, your sessions: the folders coding agents may work in on this machine (${roots}), `
        + `the coding agents it offers (${facts.agents.map((agent) => CODING_AGENT_LABELS[agent]).join(', ')}), `
        + 'and the coding sessions you hold there.',
      inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.review,
      description: 'What the session actually changed. Call it before telling the person anything is done, and '
        + 'report only what it returns.',
      inputSchema: sessionOnly,
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.send,
      description: 'A follow-up or correction for a coding session; it reaches a working session at its next step.',
      inputSchema: {
        additionalProperties: false,
        properties: { message: { maxLength: TEXT_MAX, minLength: 1, type: 'string' }, sessionId: SESSION_ID },
        required: ['sessionId', 'message'],
        type: 'object',
      },
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.start,
      description: `Start ${agentPhrase(facts)} on this machine with a task in one of these folders: ${roots}. `
        + 'The coding agent reads, edits, tests and commits on its own; you never write code yourself. Brief it '
        + 'like a senior engineer: the goal, the ticket, acceptance criteria, whether to open and merge a PR. Then '
        + 'call coding_session_wait. If coding_session_list already shows a session for this work, use '
        + 'coding_session_send instead.',
      inputSchema: {
        additionalProperties: false,
        properties: {
          agent: { enum: [...facts.agents], type: 'string' },
          path: { description: 'A folder inside the root; the root itself when absent.', maxLength: PATH_MAX, type: 'string' },
          root: { enum: [...facts.rootNames], type: 'string' },
          task: { maxLength: TEXT_MAX, minLength: 1, type: 'string' },
          title: { maxLength: TITLE_MAX, type: 'string' },
        },
        required: ['root', 'task'],
        type: 'object',
      },
    },
    {
      toolName: CODING_SESSION_TOOL_NAMES.wait,
      description: 'Wait up to 4 minutes on a coding session; it returns early when the turn ends, the session '
        + 'needs you, fails or closes, or the person writes. working means still busy — calling wait again is '
        + 'expected. waiting_for_input: read the summary, call coding_session_review, then send feedback or close. '
        + 'If the person wrote, end your turn now with one line of status; you will read their message next.',
      inputSchema: sessionOnly,
    },
  ]
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * The bridge tool's own arguments, from the model's: `task` is the bridge's
 * `prompt`, a start without `agent` gets the default agent, and a key the
 * tool does not define is left behind rather than sent to be refused.
 */
export const codingBridgeArguments = (
  toolName: CodingSessionToolName,
  args: Record<string, unknown>,
  facts: ExecutorCodingSessionsFacts,
): Record<string, unknown> => {
  switch (toolName) {
    case CODING_SESSION_TOOL_NAMES.list:
      return {}
    case CODING_SESSION_TOOL_NAMES.start: {
      const path = text(args.path)
      const title = text(args.title)
      return {
        agent: args.agent ?? defaultCodingAgent(facts),
        prompt: args.task,
        root: args.root,
        ...(path === undefined ? {} : { path }),
        ...(title === undefined ? {} : { title }),
      }
    }
    case CODING_SESSION_TOOL_NAMES.send:
      return { message: args.message, sessionId: args.sessionId }
    default:
      return { sessionId: args.sessionId }
  }
}
