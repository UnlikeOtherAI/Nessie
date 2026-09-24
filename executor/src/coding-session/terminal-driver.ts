import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ExecutorSessionScreenSchema, type ExecutorSessionScreen } from '@nessie/schemas'

import { AgentStartError, startAgentProcess, type AgentDriver, type AgentDriverContext, type AgentProcess } from './agent-process.js'
import { resolveExecutorEntry } from './host-spawn.js'
import { createDebouncedJsonWriter, writeJsonAtomic } from './session-files.js'
import { packagedJobHelper } from './process-control.js'

export const createTerminalDriver = (context: AgentDriverContext): AgentDriver => {
  let process: AgentProcess | undefined
  let screen: ExecutorSessionScreen = {
    ansi: '', cols: 120, rows: 36, capturedAt: new Date().toISOString(), kind: 'terminal',
  }
  let ending = false
  const writer = createDebouncedJsonWriter(
    join(context.paths.dir, 'terminal.json'), () => screen, context.log, 100, context.stillOwner,
  )
  const start = async (): Promise<AgentProcess> => {
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    // PTYs cannot resume a killed process. The closed screen remains readable;
    // a fresh session is required rather than silently replaying its commands.
    if (context.state().turn > 0) throw new AgentStartError('terminal_process_ended')
    const child = await startAgentProcess(context, [
      globalThis.process.execPath, ...globalThis.process.execArgv, resolveExecutorEntry(), 'terminal-session-process',
    ], (line) => {
      try {
        const message = JSON.parse(line) as { socketPath?: unknown }
        if (typeof message.socketPath === 'string') {
          void writeJsonAtomic(join(context.paths.dir, 'terminal-connection.json'), {
            socketPath: message.socketPath, session: 'nessie',
          }).catch(() => undefined)
        }
        const parsed = ExecutorSessionScreenSchema.safeParse(message)
        if (parsed.success) { screen = parsed.data; writer.schedule() }
      } catch { /* A malformed helper frame never becomes terminal content. */ }
    })
    process = child
    context.update({
      agentIdentity: child.identity, status: 'working', turn: 1, turnStartedAt: new Date().toISOString(),
    })
    const argv = [...context.agent.command, ...context.agent.args]
    if (globalThis.process.platform === 'win32') {
      const helper = packagedJobHelper() ?? (globalThis.process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
        ? undefined : fileURLToPath(new URL('../../native/target/release/nessie-executor-native.exe', import.meta.url)))
      if (!helper) throw new AgentStartError('terminal_helper_missing')
      argv.unshift(helper, 'terminal-run', '--')
    }
    child.write(`${JSON.stringify(argv)}\n`)
    void child.exited.then(async ({ code }) => {
      await writer.flush()
      if (!ending) context.update({
        status: code === 0 ? 'closed' : 'failed', reason: code === 0 ? undefined : 'terminal_process_ended',
        agentIdentity: undefined, turnStartedAt: undefined,
      })
    })
    return child
  }
  const stop = async (): Promise<void> => {
    ending = true
    if (process) {
      const descendants = await context.control.descendants(process.identity)
      await context.control.killTree(process.identity, descendants)
      await process.exited
    }
    await writer.flush()
    context.update({ agentIdentity: undefined, turnStartedAt: undefined })
  }
  return {
    send: async (data) => {
      const child = process?.alive() ? process : await start()
      if (data) child.write(`${JSON.stringify(data)}\n`)
    },
    interrupt: async () => { process?.write(`${JSON.stringify('\u0003')}\n`) },
    close: async (reason) => { await stop(); context.update({ status: 'closed', reason }) },
    endIdle: stop,
    running: () => process?.alive() === true,
    busy: () => process?.alive() === true,
  }
}
