import type { Readable } from 'node:stream'

import { executorApi } from './api-client.js'
import { createExecutorBrowserSessionManager } from './browser-session-manager.js'
import { createExecutorCodingSessionManager } from './coding-session-manager.js'
import { createExecutorCommandSessionManager } from './command-session-manager.js'
import {
  claimExecutor,
  createNonOverlappingExecutorTask,
  heartbeatExecutor,
  pollAndExecuteCommand,
  waitForExecutorDaemonShutdown,
} from './daemon.js'
import {
  createExecutorCommandAttachmentStore,
  sweepExecutorCommandAttachments,
} from './command-attachments.js'
import { createExecutorCommandRecoveryStore } from './command-recovery.js'
import { acquireExecutorDaemonLease } from './daemon-lease.js'
import { createLocalMcpReporter } from './local-mcp-report.js'
import { startExecutorLocalInferenceSupervisor } from './local-inference-supervisor.js'
import { createExecutorMcpSessionManager } from './mcp-session-manager.js'
import type { ExecutorLocalState } from './state-store.js'

/** Runs the paired executor and its sibling local Ollama host under one lease. */
export const serveExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
  options: { parentLiveness?: Readable } = {},
): Promise<void> => {
  const daemonLease = await acquireExecutorDaemonLease(stateDir)
  try {
    let live = await claimExecutor(stateDir, state)
    const localInference = await startExecutorLocalInferenceSupervisor(stateDir, live)
    live = localInference.state
    const browserSessions = createExecutorBrowserSessionManager(stateDir, live)
    const commandSessions = createExecutorCommandSessionManager(stateDir, live)
    const codingSessions = createExecutorCodingSessionManager(stateDir, live)
    const namedMcpServers = live.mcpServers ?? []
    const mcpSessions = createExecutorMcpSessionManager(namedMcpServers, live.descriptor.limits)
    const localMcp = createLocalMcpReporter(namedMcpServers, mcpSessions)
    void localMcp.refresh().catch(() => undefined)
    let shuttingDown = false
    // One store for the daemon's whole life. Building it per poll re-secured
    // the runtime directory every second, which on Windows is two native-helper
    // process spawns a second and nothing at all on POSIX.
    const recoveryStore = createExecutorCommandRecoveryStore(stateDir)
    const attachmentStore = createExecutorCommandAttachmentStore(stateDir)
    // Before the first poll, so no folder a new command writes can be swept.
    await sweepExecutorCommandAttachments(recoveryStore, attachmentStore).catch((error: unknown) => {
      console.error('[nessie-executor] attachment sweep failed:', error instanceof Error ? error.message : String(error))
    })
    const commandPoll = createNonOverlappingExecutorTask(() => pollAndExecuteCommand(
      stateDir, live, browserSessions, commandSessions, codingSessions, mcpSessions, recoveryStore, attachmentStore,
    ).catch(async (error) => {
      await browserSessions.stopAll()
      await commandSessions.stopAll()
      await codingSessions.stopAll()
      console.error('[nessie-executor] command poll failed:', error instanceof Error ? error.message : String(error))
    }))
    const heartbeat = createNonOverlappingExecutorTask(async () => {
      try {
        await heartbeatExecutor(live, localMcp.current())
      } catch (error) {
        await browserSessions.stopAll()
        await commandSessions.stopAll()
        await codingSessions.stopAll()
        if (!shuttingDown) {
          try {
            live = await claimExecutor(stateDir, live)
            live = await localInference.supervisor.reconnect(live)
          } catch (claimError) {
            console.error('[nessie-executor] reconnect failed:', claimError instanceof Error ? claimError.message : String(claimError))
          }
        }
        console.error('[nessie-executor] heartbeat failed:', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        await localInference.supervisor.heartbeat()
      } catch (error) {
        console.error('[nessie-executor] local inference heartbeat failed:', error instanceof Error ? error.message : String(error))
      }
    })
    const localInferencePoll = createNonOverlappingExecutorTask(async () => {
      try {
        await localInference.supervisor.poll()
      } catch (error) {
        console.error('[nessie-executor] local inference poll failed:', error instanceof Error ? error.message : String(error))
      }
    })
    const commandInterval = setInterval(() => {
      void commandPoll.run()
      void localInferencePoll.run()
    }, 1_000)
    const interval = setInterval(() => { void heartbeat.run() }, 20_000)
    void heartbeat.run()
    try {
      await waitForExecutorDaemonShutdown(options.parentLiveness)
    } finally {
      shuttingDown = true
      localMcp.stop()
      clearInterval(interval)
      clearInterval(commandInterval)
      executorApi.cancelPending()
      await localInference.supervisor.stop()
      await Promise.allSettled([
        ...(commandPoll.current() ? [commandPoll.current()] : []),
        ...(heartbeat.current() ? [heartbeat.current()] : []),
        ...(localInferencePoll.current() ? [localInferencePoll.current()] : []),
      ])
      await Promise.allSettled([
        browserSessions.stopAll(), commandSessions.stopAll(), codingSessions.stopAll(), mcpSessions.stopAll(),
      ])
    }
  } finally {
    await daemonLease.release()
  }
}
