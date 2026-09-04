import { createHash, createPrivateKey, sign } from 'node:crypto'
import type { Readable } from 'node:stream'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  ExecutorBrowserActArgumentsSchema,
  ExecutorBrowserObserveArgumentsSchema,
  ExecutorBrowserOpenArgumentsSchema,
  ExecutorConnectedBrowserActArgumentsSchema,
  ExecutorConnectedBrowserObserveArgumentsSchema,
  ExecutorConnectedBrowserOpenArgumentsSchema,
  ExecutorCommandRunArgumentsSchema,
  ExecutorCodingLaunchArgumentsSchema,
  ExecutorCodingObserveArgumentsSchema,
  ImplementedExecutorOperationKeySchema,
  ExecutorWorkspacePromoteArgumentsSchema,
  RunIdSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import {
  createExecutorBrowserSessionManager,
  type ExecutorBrowserSessionManager,
} from './browser-session-manager.js'
import type { ExecutorConnectedBrowserSessionManager } from './connected-browser-session-manager.js'
import {
  createExecutorCodingSessionManager,
  type ExecutorCodingSessionManager,
} from './coding-session-manager.js'
import {
  createExecutorCommandSessionManager,
  type ExecutorCommandSessionManager,
} from './command-session-manager.js'
import {
  createExecutorCommandRecoveryStore,
  recoverOrPollExecutorCommand,
} from './command-recovery.js'
import { applyNativePromotion } from './native-helper.js'
import { signedDescriptorForState } from './pair.js'
import { acquireExecutorDaemonLease } from './daemon-lease.js'
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
    connectedBrowserSessions?: ExecutorConnectedBrowserSessionManager
    commandSessions?: ExecutorCommandSessionManager
    codingSessions?: ExecutorCodingSessionManager
  } = {},
): Promise<Record<string, unknown>> => {
  if (!ImplementedExecutorOperationKeySchema.safeParse(command.operationKey).success) {
    return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
  }
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
  if (command.operationKey === 'browser.act') {
    if (!ExecutorBrowserActArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    return dependencies.browserSessions
      ? dependencies.browserSessions.act(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.open') {
    if (!ExecutorConnectedBrowserOpenArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.open(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.observe') {
    if (!ExecutorConnectedBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.act') {
    if (!ExecutorConnectedBrowserActArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.act(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'command.run') {
    if (!ExecutorCommandRunArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_COMMAND_DENIED', success: false }
    }
    return dependencies.commandSessions
      ? dependencies.commandSessions.run(command, runId.data)
      : { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false }
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
      await dependencies.connectedBrowserSessions?.stop(runId.data)
      await dependencies.commandSessions?.stop(runId.data)
      await dependencies.codingSessions?.stop(runId.data)
      return {
        status: await stopSandboxWorkspace(stateDir, runId.data) ? 'stopped' : 'no_active_sandbox',
        success: true,
      }
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  // Other declared-only operations remain unavailable.
  return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
}

const pollAndExecuteCommand = async (
  stateDir: string,
  state: ExecutorLocalState,
  browserSessions: ExecutorBrowserSessionManager,
  commandSessions: ExecutorCommandSessionManager,
  codingSessions: ExecutorCodingSessionManager,
): Promise<void> => {
  const connectionEpoch = state.connectionEpoch
  if (!connectionEpoch) return
  await recoverOrPollExecutorCommand({
    execute: (command) => executeExecutorCommand(stateDir, state, command, {
      browserSessions,
      codingSessions,
      commandSessions,
    }),
    store: createExecutorCommandRecoveryStore(stateDir),
    transport: {
      poll: async () => {
        const observedAt = new Date().toISOString()
        const payload = {
          connectionEpoch,
          executorId: state.executorId,
          observedAt,
        }
        const response = await executorApi.pollCommand(state.apiBaseUrl, {
          ...payload,
          signature: signDaemonPayload(state.machinePrivateKey, 'poll', payload),
        })
        return response.command
      },
      receipt: (input) => receipt(state, input),
    },
  })
}

export const waitForExecutorDaemonShutdown = async (
  parentLiveness?: Readable,
): Promise<void> => new Promise((resolve) => {
  const stop = () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    parentLiveness?.off('close', stop)
    parentLiveness?.off('end', stop)
    parentLiveness?.off('error', stop)
    resolve()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  if (parentLiveness) {
    parentLiveness.once('close', stop)
    parentLiveness.once('end', stop)
    parentLiveness.once('error', stop)
    parentLiveness.resume()
  }
})

export const createNonOverlappingExecutorTask = (
  task: () => Promise<void>,
): { current: () => Promise<void> | null; run: () => Promise<void> } => {
  let current: Promise<void> | null = null
  return {
    current: () => current,
    run: () => {
      if (current) return current
      const started = task().finally(() => {
        if (current === started) current = null
      })
      current = started
      return started
    },
  }
}

export const serveExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
  options: { parentLiveness?: Readable } = {},
): Promise<void> => {
  const daemonLease = await acquireExecutorDaemonLease(stateDir)
  try {
    let live = await claimExecutor(stateDir, state)
    const browserSessions = createExecutorBrowserSessionManager(stateDir, live)
    const commandSessions = createExecutorCommandSessionManager(stateDir, live)
    const codingSessions = createExecutorCodingSessionManager(stateDir, live)
    let shuttingDown = false
    const commandPoll = createNonOverlappingExecutorTask(() => pollAndExecuteCommand(
      stateDir,
      live,
      browserSessions,
      commandSessions,
      codingSessions,
    ).catch(async (error) => {
      // A lost or fenced control plane may mean that a human revoked an
      // operation. Preserve fail-closed egress by ending any live browser
      // before this daemon attempts another poll or reconnect.
      await browserSessions.stopAll()
      await commandSessions.stopAll()
      await codingSessions.stopAll()
      console.error(
        '[nessie-executor] command poll failed:',
        error instanceof Error ? error.message : String(error),
      )
    }))
    const heartbeat = createNonOverlappingExecutorTask(async () => {
      try {
        await heartbeatExecutor(live)
      } catch (error) {
        await browserSessions.stopAll()
        await commandSessions.stopAll()
        await codingSessions.stopAll()
        if (!shuttingDown) {
          try {
            live = await claimExecutor(stateDir, live)
          } catch (claimError) {
            console.error(
              '[nessie-executor] reconnect failed:',
              claimError instanceof Error ? claimError.message : String(claimError),
            )
          }
        }
        console.error(
          '[nessie-executor] heartbeat failed:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })
    const commandInterval = setInterval(() => {
      void commandPoll.run()
    }, 1_000)
    const interval = setInterval(() => {
      void heartbeat.run()
    }, 20_000)
    try {
      await waitForExecutorDaemonShutdown(options.parentLiveness)
    } finally {
      shuttingDown = true
      clearInterval(interval)
      clearInterval(commandInterval)
      executorApi.cancelPending()
      await Promise.allSettled([
        ...(commandPoll.current() ? [commandPoll.current()] : []),
        ...(heartbeat.current() ? [heartbeat.current()] : []),
      ])
      await Promise.allSettled([
        browserSessions.stopAll(),
        commandSessions.stopAll(),
        codingSessions.stopAll(),
      ])
    }
  } finally {
    await daemonLease.release()
  }
}
