import { connectExecutorLocalInference } from './local-inference-runtime.js'
import type { LocalInferencePollOutcome } from './local-inference-host.js'
import type { ExecutorLocalState } from './state-store.js'

export type ExecutorLocalInferenceSupervisor = {
  heartbeat: () => Promise<void>
  poll: () => Promise<LocalInferencePollOutcome>
  reconnect: (state: ExecutorLocalState) => Promise<ExecutorLocalState>
}

/**
 * Keep the local host tied to the executor daemon lifecycle. A reconnect is a
 * fresh local-host claim, so the server fences any previous process before it
 * can receive another sealed attempt.
 */
export const startExecutorLocalInferenceSupervisor = async (
  stateDir: string,
  state: ExecutorLocalState,
): Promise<{ state: ExecutorLocalState; supervisor: ExecutorLocalInferenceSupervisor }> => {
  let connected = await connectExecutorLocalInference(stateDir, state)
  return {
    state: connected.state,
    supervisor: {
      heartbeat: () => connected.loop.heartbeat(),
      poll: () => connected.loop.pollOnce(),
      reconnect: async (nextState) => {
        connected = await connectExecutorLocalInference(stateDir, nextState)
        return connected.state
      },
    },
  }
}
