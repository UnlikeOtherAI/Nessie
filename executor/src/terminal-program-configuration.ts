import { loadCodingSessionsConfig } from './coding-session/config.js'
import { codingSessionsConfigPath } from './coding-sessions-policy.js'
import type { ExecutorLocalState } from './state-store.js'

export type TerminalProgramInput = { command: string[]; workspaceRoot: string }

export const parseTerminalProgramInput = (value: unknown): TerminalProgramInput => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid interactive program.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'command,workspaceRoot'
    || !Array.isArray(input.command) || !input.command.length || input.command.length > 8
    || input.command.some((arg) => typeof arg !== 'string' || !arg || arg.includes('\0'))
    || typeof input.workspaceRoot !== 'string' || !input.workspaceRoot) throw new Error('Invalid interactive program.')
  return { command: input.command as string[], workspaceRoot: input.workspaceRoot }
}

/** A local editor changes only the terminal entry; structured coding agents keep their settings. */
export const terminalProgramConfiguration = async (
  stateDir: string, state: ExecutorLocalState, terminal: TerminalProgramInput,
): Promise<unknown> => {
  const previous = state.descriptor.codingSessions
    ? (await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir))).config : undefined
  return {
    ...previous,
    roots: [...(previous?.roots ?? []).filter((root) => root.name !== 'terminal'), { name: 'terminal', path: terminal.workspaceRoot }],
    agents: { ...previous?.agents, terminal: { command: terminal.command, args: [] } },
    agentEnv: previous?.agentEnv ?? { inheritUserSession: true },
  }
}
