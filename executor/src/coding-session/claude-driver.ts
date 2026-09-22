import { randomUUID } from 'node:crypto'

import {
  agentFailureReason,
  AgentStartError,
  startAgentProcess,
  type AgentDriver,
  type AgentDriverContext,
  type AgentProcess,
} from './agent-process.js'
import {
  claudeArguments,
  claudeControlLine,
  claudeDenyLine,
  claudeUserLine,
  createClaudeStreamState,
  type ClaudeSignals,
  type ClaudeStreamState,
} from './claude-adapter.js'
import type { CodingSessionResult } from './types.js'

/**
 * One long-lived Claude Code process per live host.
 *
 * Ready is the `initialize` control response. A follow-up is a stdin user
 * line, which folds into a running turn at its next tool boundary; interrupt
 * is a control request; close is `end_session`, end of stdin, and the tree
 * kill five seconds later, with the descendants read before anything was
 * signalled so a tool that outlives Claude is still found.
 */
const READY_TIMEOUT_MS = 60_000
const CLOSE_GRACE_MS = 5_000

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms).unref() })

export const createClaudeDriver = (context: AgentDriverContext): AgentDriver => {
  let agent: AgentProcess | undefined
  let stream: ClaudeStreamState | undefined
  let starting: Promise<AgentProcess> | undefined
  let interruptRequested = false
  let ending = false

  const beginTurn = (): void => {
    const state = context.state()
    if (state.status === 'working') return
    context.update({ status: 'working', reason: undefined, turn: state.turn + 1, turnStartedAt: new Date().toISOString() })
  }

  const finishTurn = (result: CodingSessionResult): void => {
    const state = context.state()
    context.update({
      status: interruptRequested ? 'interrupted' : 'waiting_for_input',
      reason: undefined,
      lastResult: result,
      permissionDenials: [...state.permissionDenials, ...result.permissionDenials].slice(-20),
      ...(result.costUsd === undefined ? {} : { totalCostUsd: (state.totalCostUsd ?? 0) + result.costUsd }),
      turnStartedAt: undefined,
    })
    interruptRequested = false
  }

  const handle = (signals: ClaudeSignals, ready: { resolve: () => void; reject: (error: Error) => void }): void => {
    for (const event of signals.events) context.emit(event)
    if (signals.ready) ready.resolve()
    if (signals.initializeFailed) ready.reject(new AgentStartError('agent_exited'))
    if (signals.agentSessionId && !context.state().agentSessionStarted) {
      context.update({ agentSessionId: signals.agentSessionId, agentSessionStarted: true })
    }
    if (signals.active) beginTurn()
    if (signals.answerControlRequest) {
      agent?.write(claudeDenyLine(signals.answerControlRequest.requestId, signals.answerControlRequest.supported))
    }
    if (signals.test) context.update({ lastTest: signals.test })
    if (signals.turnFinished) finishTurn(signals.turnFinished)
  }

  const start = async (): Promise<AgentProcess> => {
    const state = context.state()
    const sessionId = state.agentSessionId ?? randomUUID()
    const resume = state.agentSessionId !== undefined && state.agentSessionStarted === true
    if (state.agentSessionId === undefined) context.update({ agentSessionId: sessionId })
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    const current = createClaudeStreamState(context.projector)
    stream = current
    let resolveReady = (): void => undefined
    let rejectReady = (_error: Error): void => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const readyHooks = { resolve: () => resolveReady(), reject: (error: Error) => rejectReady(error) }
    const spawned = await startAgentProcess(context, [
      context.agent.command[0]!,
      ...claudeArguments(context.agent, {
        sessionId, resume, ...(context.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: context.maxBudgetUsd }),
      }),
    ], (line) => handle(current.accept(line), readyHooks))
    agent = spawned
    context.update({ agentIdentity: spawned.identity })
    void spawned.exited.then(({ code }) => {
      if (agent === spawned) agent = undefined
      const reason = agentFailureReason(spawned.stderrTail())
      rejectReady(new AgentStartError(reason))
      if (ending) return
      context.log(`claude exited with code ${code}`)
      const busy = current.busy()
      context.update({ agentIdentity: undefined })
      if (busy || context.state().status === 'working' || context.state().status === 'starting') {
        context.emit({ kind: 'system', subtype: 'agent_exited', reason })
        context.update({ status: 'interrupted', reason, turnStartedAt: undefined })
      }
    })
    spawned.write(claudeControlLine('initialize'))
    const timer = setTimeout(() => rejectReady(new AgentStartError('agent_exited')), READY_TIMEOUT_MS)
    try {
      await ready
    } finally {
      clearTimeout(timer)
    }
    return spawned
  }

  const ensureAgent = async (): Promise<AgentProcess> => {
    if (agent?.alive()) return agent
    starting ??= start().finally(() => { starting = undefined })
    return starting
  }

  const stop = async (): Promise<void> => {
    const current = agent
    const identity = current?.identity ?? context.state().agentIdentity
    if (!identity) return
    ending = true
    const snapshot = await context.control.descendants(identity.pid)
    if (current?.alive()) {
      current.write(claudeControlLine('end_session'))
      current.endInput()
      await Promise.race([current.exited, delay(CLOSE_GRACE_MS)])
    }
    await context.control.killTree(identity, snapshot)
    agent = undefined
    context.update({ agentIdentity: undefined })
    ending = false
  }

  return {
    send: async (text, uuid) => {
      const running = await ensureAgent()
      stream?.noteSent(uuid)
      beginTurn()
      running.write(claudeUserLine(uuid, text))
    },
    interrupt: async () => {
      if (!agent?.alive() || !stream?.busy()) return
      interruptRequested = true
      agent.write(claudeControlLine('interrupt'))
    },
    close: async () => {
      await stop()
      context.update({ status: 'closed', reason: undefined, turnStartedAt: undefined })
    },
    endIdle: stop,
    running: () => agent?.alive() === true || starting !== undefined,
    busy: () => starting !== undefined || agent?.alive() === true && stream?.busy() === true,
  }
}
