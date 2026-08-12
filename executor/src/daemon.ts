import { createHash, createPrivateKey, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  ExecutorBrowserObserveArgumentsSchema,
  ExecutorBrowserOpenArgumentsSchema,
  ExecutorCodingLaunchArgumentsSchema,
  ExecutorCodingObserveArgumentsSchema,
  ExecutorWorkspacePromoteArgumentsSchema,
  RunIdSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import {
  createExecutorBrowserSessionManager,
  type ExecutorBrowserSessionManager,
} from './browser-session-manager.js'
import {
  createExecutorCodingSessionManager,
  type ExecutorCodingSessionManager,
} from './coding-session-manager.js'
import { applyNativePromotion } from './native-helper.js'
import { signedDescriptorForState } from './pair.js'
import {
  stopSandboxWorkspace,
  reviewSandboxWorkspace,
  promotionManifestForSandbox,
  workspaceForRun,
  writeSandboxFile,
} from './sandbox-workspace.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'
import { listWorkspaceFiles, readWorkspaceFile, workspaceFailure } from './workspace.js'

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

export const executeExecutorCommand = async (
  stateDir: string,
  state: ExecutorLocalState,
  command: ExecutorCommandEnvelope,
  dependencies: {
    browserSessions?: ExecutorBrowserSessionManager
    codingSessions?: ExecutorCodingSessionManager
  } = {},
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
  if (digest(command.payload) !== command.argumentDigest) {
    return { code: 'EXECUTOR_COMMAND_DIGEST_INVALID', success: false }
  }
  const runId = RunIdSchema.safeParse(command.payload.runId)
  if (!runId.success) {
    return { code: 'EXECUTOR_COMMAND_RUN_INVALID', success: false }
  }
  if (command.operationKey === 'file.list') {
    try {
      const workspace = await workspaceForRun(stateDir, state.workspaceRoot, runId.data)
      return await listWorkspaceFiles(workspace, command.payload.args)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'file.read') {
    try {
      const workspace = await workspaceForRun(stateDir, state.workspaceRoot, runId.data)
      return await readWorkspaceFile(workspace, command.payload.args)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'file.write') {
    try {
      return await writeSandboxFile(stateDir, state.workspaceRoot, runId.data, command.payload.args)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'workspace.review') {
    try {
      return await reviewSandboxWorkspace(stateDir, runId.data)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'workspace.promote') {
    try {
      const args = ExecutorWorkspacePromoteArgumentsSchema.parse(command.payload.args)
      const manifest = await promotionManifestForSandbox(stateDir, runId.data)
      if (manifest.manifestDigest !== args.manifestDigest) {
        return { code: 'EXECUTOR_PROMOTION_REVIEW_STALE', success: false }
      }
      const draftWorkspace = await workspaceForRun(stateDir, state.workspaceRoot, runId.data)
      return await applyNativePromotion({
        draftWorkspace,
        helperPath: state.nativeHelperPath,
        request: {
          ...manifest,
          approvalDigest: args.approvalDigest,
          bindingFence: command.bindingFence,
          promotionId: args.promotionId,
        },
        workspaceRoot: state.workspaceRoot,
      })
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'browser.open') {
    if (!ExecutorBrowserOpenArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    return dependencies.browserSessions
      ? dependencies.browserSessions.open(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.observe') {
    if (!ExecutorBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    return dependencies.browserSessions
      ? dependencies.browserSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'coding.launch') {
    if (!ExecutorCodingLaunchArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_CODING_DENIED', success: false }
    }
    return dependencies.codingSessions
      ? dependencies.codingSessions.launch(command, runId.data)
      : { code: 'EXECUTOR_CODING_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'coding.observe') {
    if (!ExecutorCodingObserveArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_CODING_DENIED', success: false }
    }
    return dependencies.codingSessions
      ? dependencies.codingSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_CODING_UNAVAILABLE', success: false }
  }
  // Stop can discard only its exact server-provenanced run scratch directory.
  if (command.operationKey === 'sandbox.stop') {
    try {
      await dependencies.browserSessions?.stop(runId.data)
      await dependencies.codingSessions?.stop(runId.data)
      return {
        status: await stopSandboxWorkspace(stateDir, runId.data) ? 'stopped' : 'no_active_sandbox',
        success: true,
      }
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  // Shell and other unimplemented operations remain unavailable.
  return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
}

const pollAndExecuteCommand = async (
  stateDir: string,
  state: ExecutorLocalState,
  browserSessions: ExecutorBrowserSessionManager,
  codingSessions: ExecutorCodingSessionManager,
): Promise<void> => {
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
  const result = await executeExecutorCommand(stateDir, state, command, { browserSessions, codingSessions })
  await receipt(state, { commandId: command.commandId, result, state: 'result_acknowledged' })
}

export const serveExecutor = async (stateDir: string, state: ExecutorLocalState): Promise<void> => {
  let live = await claimExecutor(stateDir, state)
  const browserSessions = createExecutorBrowserSessionManager(stateDir, live)
  const codingSessions = createExecutorCodingSessionManager(stateDir, live)
  let commandPollInFlight = false
  const commandInterval = setInterval(() => {
    if (commandPollInFlight) return
    commandPollInFlight = true
    void pollAndExecuteCommand(stateDir, live, browserSessions, codingSessions)
      .catch(async (error) => {
        // A lost or fenced control plane may mean that a human revoked an
        // operation. Preserve fail-closed egress by ending any live browser
        // before this daemon attempts another poll or reconnect.
        await browserSessions.stopAll()
        await codingSessions.stopAll()
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
        await browserSessions.stopAll()
        await codingSessions.stopAll()
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
  await browserSessions.stopAll()
  await codingSessions.stopAll()
}
