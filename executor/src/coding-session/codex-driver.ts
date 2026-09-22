import {
  agentFailureReason,
  AgentStartError,
  startAgentProcess,
  type AgentDriver,
  type AgentDriverContext,
  type AgentProcess,
} from './agent-process.js'
import { codexArguments, createCodexTurnState } from './codex-adapter.js'
import { CODING_EVENT_LIMITS } from './projection.js'

/**
 * Codex runs one `exec` process per turn. `thread.started` names the session,
 * which every later turn resumes. A message sent during a turn waits for it
 * to end and then starts the next one, joined with any other waiting message;
 * interrupt kills the turn's process tree, and the thread stays resumable from
 * its rollout.
 */
export const createCodexDriver = (context: AgentDriverContext): AgentDriver => {
  let turn: { agent: AgentProcess; interrupted: boolean; done: Promise<void> } | undefined
  let starting = false
  let closing = false
  const queue: string[] = []

  const runTurn = async (text: string): Promise<void> => {
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    const state = context.state()
    const threadId = state.agentSessionStarted === true ? state.agentSessionId : undefined
    const current = createCodexTurnState(context.projector)
    starting = true
    let agent: AgentProcess
    try {
      agent = await startAgentProcess(context, [
        context.agent.command[0]!,
        ...codexArguments(context.agent, { folder: context.folder, ...(threadId ? { threadId } : {}) }),
      ], (line) => {
        const signals = current.accept(line)
        for (const event of signals.events) context.emit(event)
        if (signals.threadId && !context.state().agentSessionStarted) {
          context.update({ agentSessionId: signals.threadId, agentSessionStarted: true })
        }
        if (signals.test) context.update({ lastTest: signals.test })
      })
    } finally {
      starting = false
    }
    context.emit({ kind: 'user', text: context.projector.text(text, CODING_EVENT_LIMITS.user) })
    context.update({
      status: 'working', reason: undefined, turn: state.turn + 1, turnStartedAt: new Date().toISOString(),
      agentIdentity: agent.identity,
    })
    agent.write(text)
    agent.endInput()
    const entry = { agent, interrupted: false, done: Promise.resolve() }
    entry.done = agent.exited.then(({ code }) => {
      turn = undefined
      const result = current.finish({ code, interrupted: entry.interrupted })
      context.emit({ kind: 'result', ...result })
      const reason = result.subtype === 'agent_exited' ? agentFailureReason(agent.stderrTail()) : undefined
      context.update({
        status: closing ? 'closed' : entry.interrupted ? 'interrupted' : 'waiting_for_input',
        reason, lastResult: result, agentIdentity: undefined, turnStartedAt: undefined,
      })
      if (closing || queue.length === 0) return
      const next = queue.splice(0).join('\n\n')
      context.update({ queued: 0 })
      void runTurn(next).catch((error: unknown) => {
        const failure = error instanceof AgentStartError ? error.reason : 'agent_exited'
        context.update({ status: 'interrupted', reason: failure })
      })
    })
    turn = entry
  }

  const killTurn = async (): Promise<void> => {
    const current = turn
    if (!current) return
    current.interrupted = true
    const snapshot = await context.control.descendants(current.agent.identity.pid)
    await context.control.killTree(current.agent.identity, snapshot)
    await current.done
  }

  return {
    send: async (text) => {
      if (turn || starting) {
        queue.push(text)
        context.update({ queued: queue.length })
        return
      }
      await runTurn(text)
    },
    interrupt: killTurn,
    close: async () => {
      closing = true
      queue.length = 0
      await killTurn()
      const leftover = context.state().agentIdentity
      if (leftover) await context.control.killTree(leftover, await context.control.descendants(leftover.pid))
      context.update({ status: 'closed', reason: undefined, queued: 0, agentIdentity: undefined, turnStartedAt: undefined })
    },
    endIdle: async () => undefined,
    running: () => turn !== undefined || starting,
    busy: () => turn !== undefined || starting || queue.length > 0,
  }
}
