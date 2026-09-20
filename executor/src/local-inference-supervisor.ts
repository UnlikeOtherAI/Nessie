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
  let desiredState = state
  let connected: Awaited<ReturnType<typeof connectExecutorLocalInference>> | null = null
  const connect = async (nextState: ExecutorLocalState): Promise<ExecutorLocalState> => {
    desiredState = nextState
    connected = await connectExecutorLocalInference(stateDir, desiredState)
    desiredState = connected.state
    return desiredState
  }
  try {
    await connect(state)
  } catch {
    // Local inference is an optional sibling of the paired executor. Its
    // policy/route may be unavailable while browser, command and MCP work must
    // remain live; the regular daemon loop will retry this bounded operation.
    connected = null
  }
  return {
    state: desiredState,
    supervisor: {
      heartbeat: async () => {
        try {
          if (!connected) await connect(desiredState)
          const live = connected
          if (!live) return
          await live.loop.heartbeat()
        } catch {
          connected = null
        }
      },
      poll: async () => {
        if (!connected) return { kind: 'idle' }
        try {
          return await connected.loop.pollOnce()
        } catch (error) {
          connected = null
          throw error
        }
      },
      reconnect: async (nextState) => {
        try {
          return await connect(nextState)
        } catch {
          connected = null
          return nextState
        }
      },
    },
  }
}
