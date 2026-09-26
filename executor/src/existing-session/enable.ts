import { loadCodingSessionsConfig } from '../coding-session/config.js'
import { codingSessionsConfigPath, type ExecutorRuntime } from '../coding-sessions-policy.js'
import { configureExecutorLocalPolicy } from '../pair.js'
import type { ExecutorLocalState } from '../state-store.js'

/** Existing executor authority is sufficient, including pairings made before this capability existed. */
export const enableExistingSessionBridge = async (
  stateDir: string, state: ExecutorLocalState, runtime?: ExecutorRuntime,
): Promise<ExecutorLocalState> => {
  if (state.descriptor.codingSessions?.existingSessions) return state
  const previous = state.descriptor.codingSessions
  const loaded = previous ? await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir)) : undefined
  if (loaded && loaded.digest !== previous?.configDigest) {
    throw new Error('The coding-session configuration changed. Apply the local configuration before starting the executor.')
  }
  return configureExecutorLocalPolicy(stateDir, state,
    [...new Set([...state.descriptor.operationKeys, 'mcp.tools', 'mcp.call'])],
    undefined, undefined, undefined, undefined, undefined,
    { requested: loaded?.config ?? { roots: [], agents: {}, existingSessions: true }, runtime })
}
