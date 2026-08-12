import { createPrivateKey, sign } from 'node:crypto'

import { canonicalExecutorPayload } from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { signedDescriptorForState } from './pair.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'

const signDaemonPayload = (
  privateKeyDer: string,
  domain: 'claim' | 'heartbeat',
  payload: Record<string, string>,
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

export const serveExecutor = async (stateDir: string, state: ExecutorLocalState): Promise<void> => {
  let live = await claimExecutor(stateDir, state)
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
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
