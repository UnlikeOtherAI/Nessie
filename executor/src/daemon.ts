import { createHash, createPrivateKey, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { signedDescriptorForState } from './pair.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'

const signDaemonPayload = (
  privateKeyDer: string,
  domain: 'claim' | 'heartbeat' | 'poll' | 'receipt',
  payload: Record<string, unknown>,
): string => sign(
  null,
  Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${domain}.v1`, payload)),
  createPrivateKey({
    format: 'der',
    key: Buffer.from(privateKeyDer, 'base64url'),
    type: 'pkcs8',
  }),
).toString('base64url')

export const claimExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
): Promise<ExecutorLocalState> => {
  const issued = await executorApi.issueChallenge(state.apiBaseUrl, state.executorId)
  const signature = signDaemonPayload(state.machinePrivateKey, 'claim', {
    challenge: issued.challenge,
    executorId: state.executorId,
  })
  const connection = await executorApi.claim(state.apiBaseUrl, {
    challenge: issued.challenge,
    executorId: state.executorId,
    signature,
  })
  const next = { ...state, connectionEpoch: connection.connectionEpoch }
  await executorApi.submitDescriptor(next.apiBaseUrl, {
    connectionEpoch: connection.connectionEpoch,
    descriptor: signedDescriptorForState(next),
    executorId: next.executorId,
  })
  await saveExecutorState(stateDir, next)
  return next
}

export const heartbeatExecutor = async (
  state: ExecutorLocalState,
): Promise<void> => {
  if (!state.connectionEpoch) {
    throw new Error('Executor has not claimed a live daemon connection.')
  }
  const observedAt = new Date().toISOString()
  const signature = signDaemonPayload(state.machinePrivateKey, 'heartbeat', {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    observedAt,
  })
  await executorApi.heartbeat(state.apiBaseUrl, {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    observedAt,
    signature,
  })
}

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

const receipt = async (
  state: ExecutorLocalState,
  input: {
    commandId: ExecutorCommandEnvelope['commandId']
    result?: Record<string, unknown>
    state: 'accepted' | 'started' | 'result_acknowledged'
  },
): Promise<void> => {
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const occurredAt = new Date().toISOString()
  const commandReceipt = {
    commandId: input.commandId,
    occurredAt,
    ...(input.result ? { resultDigest: digest(input.result) } : {}),
    state: input.state,
  }
  const payload = {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    receipt: commandReceipt,
  }
  await executorApi.recordCommandReceipt(state.apiBaseUrl, {
    ...payload,
    ...(input.result ? { result: input.result } : {}),
    signature: signDaemonPayload(state.machinePrivateKey, 'receipt', payload),
  })
}

const executeLocalCommand = async (
  state: ExecutorLocalState,
  command: ExecutorCommandEnvelope,
): Promise<Record<string, unknown>> => {
  if (new Date(command.expiresAt) <= new Date()) {
    return { code: 'EXECUTOR_COMMAND_EXPIRED', success: false }
  }
  if (command.capabilityRevision !== state.descriptor.revision) {
    return { code: 'EXECUTOR_DESCRIPTOR_STALE', success: false }
  }
  if (!state.descriptor.operationKeys.includes(command.operationKey)) {
    return { code: 'EXECUTOR_LOCAL_POLICY_DENIED', success: false }
  }
  // Pairing/presence profile intentionally has no data or shell capability.
  // `sandbox.stop` is safe locally and establishes the complete signed receipt
  // path before a micro-VM backend advertises further operations.
  if (command.operationKey === 'sandbox.stop') {
    return { status: 'no_active_sandbox', success: true }
  }
  return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
}

const pollAndExecuteCommand = async (state: ExecutorLocalState): Promise<void> => {
  if (!state.connectionEpoch) return
  const observedAt = new Date().toISOString()
  const payload = { connectionEpoch: state.connectionEpoch, executorId: state.executorId, observedAt }
  const response = await executorApi.pollCommand(state.apiBaseUrl, {
    ...payload,
    signature: signDaemonPayload(state.machinePrivateKey, 'poll', payload),
  })
  const command = response.command
  if (!command) return
  await receipt(state, { commandId: command.commandId, state: 'accepted' })
  await receipt(state, { commandId: command.commandId, state: 'started' })
  const result = await executeLocalCommand(state, command)
  await receipt(state, { commandId: command.commandId, result, state: 'result_acknowledged' })
}

export const serveExecutor = async (stateDir: string, state: ExecutorLocalState): Promise<void> => {
  let live = await claimExecutor(stateDir, state)
  let commandPollInFlight = false
  const commandInterval = setInterval(() => {
    if (commandPollInFlight) return
    commandPollInFlight = true
    void pollAndExecuteCommand(live)
      .catch((error) => {
        console.error(
          '[nessie-executor] command poll failed:',
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        commandPollInFlight = false
      })
  }, 1_000)
  const interval = setInterval(() => {
    void (async () => {
      try {
        await heartbeatExecutor(live)
      } catch (error) {
        try {
          live = await claimExecutor(stateDir, live)
        } catch (claimError) {
          console.error(
            '[nessie-executor] reconnect failed:',
            claimError instanceof Error ? claimError.message : String(claimError),
          )
        }
        console.error(
          '[nessie-executor] heartbeat failed:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()
  }, 20_000)
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(interval)
      clearInterval(commandInterval)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
