import type { LoadedCodingSessionsConfig } from './config.js'
import { CODING_SESSION_ID_PATTERN } from './types.js'

/**
 * The bridge's tool catalogue. The worker (not this server) owns the
 * descriptions a model is shown for its first-class coding tools; these are
 * for a person reading `mcp.tools`, and the input schemas are real so scalar
 * coercion works. `session_close_all` and `session_list_all` are deliberately
 * not listed: they are the daemon's own teardown and heartbeat-report calls,
 * refused without its reserved `_meta` marker.
 */

const sessionIdSchema = { type: 'string' as const, pattern: CODING_SESSION_ID_PATTERN.source }

export const codingBridgeTools = (loaded: LoadedCodingSessionsConfig) => {
  const agents = Object.keys(loaded.config.agents)
  const roots = loaded.config.roots.map((root) => root.name)
  const session = (description: string, name: string) => ({
    name, description,
    inputSchema: {
      type: 'object' as const, additionalProperties: false, required: ['sessionId'],
      properties: { sessionId: sessionIdSchema },
    },
  })
  return [
    {
      name: 'session_list',
      description: 'List the folders and coding agents this machine offers, and your own coding sessions.',
      inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
    },
    {
      name: 'session_start',
      description: 'Start a coding agent on this machine with a task in one of its folders. Returns at once; '
        + 'poll session_status to follow it.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['agent', 'root', 'prompt'],
        properties: {
          agent: { type: 'string', enum: agents },
          root: { type: 'string', enum: roots },
          path: { type: 'string', maxLength: 1_000, description: 'A folder inside the root; the root itself when absent.' },
          prompt: { type: 'string', maxLength: 32_000 },
          title: { type: 'string', maxLength: 120 },
        },
      },
    },
    {
      name: 'session_status',
      description: 'What a session is doing now, and what happened since you last asked. Never waits.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['sessionId'],
        properties: {
          sessionId: sessionIdSchema,
          detail: { type: 'string', enum: ['summary', 'events'] },
          cursor: { type: 'string', maxLength: 64 },
        },
      },
    },
    {
      name: 'session_send',
      description: 'Send a follow-up or a correction. A working session reads it at its next step.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['sessionId', 'message'],
        properties: {
          sessionId: sessionIdSchema, message: { type: 'string', minLength: 1, maxLength: 32_000 },
          terminal: { type: 'boolean' },
        },
      },
    },
    session('Stop the current turn. The session stays open and can be sent a new message.', 'session_interrupt'),
    session('What the session actually changed: branch, commits, diff, worktrees and pull requests.', 'session_review'),
    session('End the session and every process it started. Its history stays readable.', 'session_close'),
    session('Read the current interactive terminal screen as text.', 'terminal_read'),
  ]
}

export class CodingBridgeError extends Error {
  override readonly name = 'CodingBridgeError'
  constructor(readonly code: string, message: string) { super(message) }
}

export const invalidArguments = (message: string): never => {
  throw new CodingBridgeError('coding_session_invalid_arguments', message)
}

/** The model's arguments, refusing any key the tool does not define. */
export const argumentsFor = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  const args = value ?? {}
  if (typeof args !== 'object' || Array.isArray(args)) return invalidArguments('Arguments must be an object.')
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) invalidArguments(`Unknown argument: ${unknown[0]!.slice(0, 40)}.`)
  return args as Record<string, unknown>
}

export const requiredText = (value: unknown, name: string, maxLength: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    return invalidArguments(`${name} must be text of at most ${maxLength} characters.`)
  }
  return value
}

export const sessionIdArgument = (value: unknown): string => {
  if (typeof value !== 'string' || !CODING_SESSION_ID_PATTERN.test(value)) {
    throw new CodingBridgeError('coding_session_not_found', 'No such session.')
  }
  return value
}
