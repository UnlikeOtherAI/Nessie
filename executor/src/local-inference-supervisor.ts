import { connectExecutorLocalInference } from './local-inference-runtime.js'
import type { LocalInferencePollOutcome } from './local-inference-host.js'
import type { ExecutorLocalState } from './state-store.js'
import { LocalInferencePollPump } from './local-inference-poll-pump.js'

export type ExecutorLocalInferenceSupervisor = {
  heartbeat: () => Promise<void>
  poll: () => Promise<LocalInferencePollOutcome>
  reconnect: (state: ExecutorLocalState) => Promise<ExecutorLocalState>
  stop: () => Promise<void>
}

/**
 * Keep the local host tied to the executor daemon lifecycle. A reconnect is a
 * fresh local-host claim, so the server fences any previous process before it
 * can receive another sealed attempt.
 */
export const startExecutorLocalInferenceSupervisor = async (
  stateDir: string,
  state: ExecutorLocalState,
  connectLocal: typeof connectExecutorLocalInference = connectExecutorLocalInference,
): Promise<{ state: ExecutorLocalState; supervisor: ExecutorLocalInferenceSupervisor }> => {
  let desiredState = state
  let connected: Awaited<ReturnType<typeof connectExecutorLocalInference>> | null = null
  let pump: LocalInferencePollPump | null = null
  const connect = async (nextState: ExecutorLocalState): Promise<ExecutorLocalState> => {
    await pump?.stop()
    desiredState = nextState
    connected = await connectLocal(stateDir, desiredState)
    pump = new LocalInferencePollPump(connected.loop, (error) => {
      console.error('[nessie-executor] local inference poll failed:', error instanceof Error ? error.message : String(error))
    })
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
          await pump?.stop()
          pump = null
          connected = null
        }
      },
      poll: async () => {
        pump?.tick()
        return { kind: 'idle' }
      },
      stop: async () => { await pump?.stop(); pump = null; connected = null },
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
