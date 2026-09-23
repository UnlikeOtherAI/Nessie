import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'

import { AgentStartError, type AgentDriver } from './agent-process.js'
import { buildAgentEnvironment } from './agent-env.js'
import { createClaudeDriver } from './claude-driver.js'
import { createCodexDriver } from './codex-driver.js'
import { codingSessionsDigestMatches, loadCodingSessionsConfig, type LoadedCodingSessionsConfig } from './config.js'
import { executorRuntimeDigest, resolveExecutorEntry } from './host-spawn.js'
import { stopOwnUserUnit } from './host-unit.js'
import { createCodingProcessControl, type CodingProcessControl } from './process-control.js'
import { createProjector, type Projector } from './projection.js'
import { gitStartSnapshot } from './review.js'
import { findCodingRoot, resolveCodingFolder, resolveCodingRoots } from './roots.js'
import { runCodingSelfCheck } from './self-check.js'
import { openEventLog } from './session-events.js'
import { codingSessionPaths, createDebouncedJsonWriter, readJson, type CodingSessionPaths } from './session-files.js'
import { acquireHostLock, HOST_HEARTBEAT_MS, type HeldHostLock } from './session-lock.js'
import { inboxHasRequests, listRequests, readSessionMeta, removeRequest } from './session-requests.js'
import {
  initialCodingSessionState,
  type CodingEventBody,
  type CodingSessionMeta,
  type CodingSessionRequest,
  type CodingSessionState,
} from './types.js'

/**
 * `nessie-executor coding-session-host --config <path> --session <id>`: the
 * detached process that owns one session's coding agent and all of its state.
 *
 * It takes the session's lock, acts on inbox requests in order, and exits once
 * no agent is alive and nothing is left to do — removing its lock and then
 * looking at the inbox once more, so a request written in that instant is
 * never stranded. A host that finds its lock taken over exits at once without
 * writing anything, and every host kills a previous host's still-running agent
 * before it starts or resumes one of its own.
 *
 * When the reviewed config digest no longer matches the file, a host still
 * processes interrupts and closes (which only stop things) but refuses to start
 * or resume an agent.
 */

const POLL_MS = 300
const MAX_LOG_BYTES = 1024 * 1024

/**
 * What the next host needs if this one dies: which agent process to kill and
 * which agent session to resume. These skip the debounce and are written at
 * once: a host killed inside the 500 ms window otherwise left the next one a
 * `working` session with no confirmed agent session, so it started the agent
 * afresh instead of resuming it (seen on Windows under load).
 */
const RECOVERY_FIELDS = ['agentIdentity', 'agentSessionId', 'agentSessionStarted'] as const

type HostContext = {
  control: CodingProcessControl
  loaded: LoadedCodingSessionsConfig
  meta: CodingSessionMeta
  paths: CodingSessionPaths
  projector: Projector
  log: (message: string) => void
  mayRunAgent: boolean
  roots: Awaited<ReturnType<typeof resolveCodingRoots>>
}

class HostSuperseded extends Error {}

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

const hostLogger = (): ((message: string) => void) => {
  let written = 0
  return (message) => {
    if (written > MAX_LOG_BYTES) return
    const line = `${new Date().toISOString()} ${message}\n`
    written += line.length
    process.stderr.write(written > MAX_LOG_BYTES ? 'host log limit reached\n' : line)
  }
}

/** Serves the session while this host holds the lock; `true` means it was asked to retire. */
const serveSession = async (context: HostContext, lock: HeldHostLock): Promise<boolean> => {
  const { control, loaded, meta, paths, log } = context
  const previous = await readJson<CodingSessionState>(paths.state)
  const state: CodingSessionState = previous?.version === 1
    ? previous
    : initialCodingSessionState(new Date().toISOString())
  const writer = createDebouncedJsonWriter(paths.state, () => state, log)
  const position = { generation: state.eventsGeneration, lastSeq: state.lastSeq }
  const events = await openEventLog(paths, position, (next) => {
    state.eventsGeneration = next.generation
    state.lastSeq = next.lastSeq
    writer.schedule()
  })
  const emit = (body: CodingEventBody): void => {
    void events.append(body).catch((error: unknown) => log(`event append failed: ${String(error)}`))
  }
  const update = (patch: Partial<CodingSessionState>): void => {
    const before = state.status
    Object.assign(state, patch)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (state as Record<string, unknown>)[key]
    }
    state.updatedAt = new Date().toISOString()
    if (patch.status && patch.status !== before) {
      emit({ kind: 'system', subtype: 'status', status: patch.status, ...(state.reason ? { reason: state.reason } : {}) })
    }
    if (RECOVERY_FIELDS.some((key) => key in patch)) void writer.flush()
    else writer.schedule()
  }

  // A previous host died mid-turn: say so, and stop its agent before anything else runs.
  if (previous && (state.status === 'working' || state.status === 'starting') && state.turn > 0) {
    update({ status: 'interrupted', reason: 'host_lost', turnStartedAt: undefined })
  }
  // An agent session id the agent never confirmed may or may not exist: Claude
  // creates it on the first message, and refuses `--session-id` for an id it
  // already has. So an unconfirmed id is dropped and the next agent starts afresh.
  if (state.agentSessionId !== undefined && state.agentSessionStarted !== true) update({ agentSessionId: undefined })
  if (state.agentIdentity) {
    log('stopping the previous host\'s agent')
    await control.killTree(state.agentIdentity)
    update({ agentIdentity: undefined })
  }

  let driver: AgentDriver | undefined
  let retiring = false
  let superseded = false
  const prepare = async (): Promise<AgentDriver> => {
    if (driver) return driver
    const agent = loaded.config.agents[meta.agent]
    if (!agent) throw new AgentStartError('agent_unavailable')
    const folder = await resolveCodingFolder(findCodingRoot(context.roots, meta.rootName), meta.path)
      .catch(() => { throw new AgentStartError('root_unavailable') })
    const env = await buildAgentEnvironment({ config: loaded.config.agentEnv })
    const check = await runCodingSelfCheck({ agent: meta.agent, config: agent, cwd: folder, env })
    if (!check.ok) throw new AgentStartError(check.reason)
    if (check.agentVersion) update({ agentVersion: context.projector.line(check.agentVersion, 80) })
    if (state.baseCommit === undefined && state.worktreesAtStart === undefined) update(await gitStartSnapshot(folder))
    const driverContext = {
      agent, control, env, folder, paths, projector: context.projector, log, emit, update, state: () => state,
      stillOwner: lock.stillOurs,
      ...(loaded.config.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: loaded.config.maxBudgetUsd }),
    }
    driver = meta.agent === 'claude' ? createClaudeDriver(driverContext) : createCodexDriver(driverContext)
    return driver
  }

  const deliver = async (text: string): Promise<void> => {
    if (!context.mayRunAgent) {
      emit({ kind: 'system', subtype: 'refused', reason: 'config_changed' })
      if (!state.agentSessionStarted) update({ status: 'failed', reason: 'config_changed' })
      return
    }
    try {
      await (await prepare()).send(text, randomUUID())
    } catch (error) {
      const reason = error instanceof AgentStartError ? error.reason : 'agent_exited'
      if (reason === 'host_superseded') throw new HostSuperseded()
      log(`the agent could not start: ${reason}`)
      emit({ kind: 'system', subtype: 'agent_failed', reason })
      update({ status: state.agentSessionStarted ? 'interrupted' : 'failed', reason, turnStartedAt: undefined })
    }
  }

  const handle = async (request: CodingSessionRequest): Promise<void> => {
    if (request.kind === 'retire') {
      retiring = true
    } else if (request.kind === 'close') {
      if (driver) await driver.close()
      else update({ status: 'closed', reason: undefined, turnStartedAt: undefined })
    } else if (request.kind === 'interrupt') {
      await driver?.interrupt()
    } else if (state.status === 'closed' || state.status === 'failed') {
      emit({ kind: 'system', subtype: 'ignored', reason: state.status })
    } else if (request.kind === 'start' && state.turn > 0) {
      // A start this session already acted on (a replay the bridge let through); nothing to do.
    } else {
      await deliver(request.text ?? '')
    }
  }

  const heartbeat = setInterval(() => {
    void (async () => {
      if (await lock.heartbeat().catch(() => true)) return
      // Another host owns the session now. Stop our agent and leave without writing.
      superseded = true
      const identity = state.agentIdentity
      if (identity) await control.killTree(identity)
      process.exit(0)
    })().catch((error: unknown) => log(`heartbeat failed: ${String(error)}`))
  }, HOST_HEARTBEAT_MS)

  // Checked between requests, never beside one, so ending an idle agent cannot race a follow-up.
  const enforceLimits = async (): Promise<void> => {
    const now = Date.now()
    if (driver?.busy() && state.turnStartedAt
      && now - Date.parse(state.turnStartedAt) > loaded.config.maxTurnMinutes * 60_000) {
      emit({ kind: 'system', subtype: 'limit', reason: 'max_turn_minutes' })
      update({ turnStartedAt: undefined })
      await driver.interrupt()
    } else if (driver?.running() && !driver.busy()
      && now - Date.parse(state.updatedAt) > loaded.config.idleMinutes * 60_000) {
      log('ending the idle agent')
      await driver.endIdle()
    }
  }

  try {
    for (;;) {
      const requests = await listRequests(paths)
      // Everything after a close is still consumed: a send there is reported ignored, not left waiting.
      for (const request of requests) {
        await handle(request)
        await removeRequest(paths, request.id)
      }
      if (state.status === 'closed' || superseded) break
      if (retiring && !driver?.busy()) break
      if (requests.length === 0 && !driver?.running() && !driver?.busy()) break
      if (requests.length === 0) await enforceLimits()
      await delay(POLL_MS)
    }
    if (retiring && driver?.running()) await driver.endIdle()
  } catch (error) {
    if (!(error instanceof HostSuperseded)) throw error
    superseded = true
  } finally {
    clearInterval(heartbeat)
    await events.close()
    if (!superseded) await writer.flush()
  }
  return retiring || superseded
}

export const runCodingSessionHost = async (input: { configPath: string; sessionId: string }): Promise<void> => {
  const log = hostLogger()
  const loaded = await loadCodingSessionsConfig(input.configPath)
  const paths = codingSessionPaths(loaded.stateDir, input.sessionId)
  const meta = await readSessionMeta(paths)
  if (!meta) {
    log('no such session')
    return
  }
  const roots = await resolveCodingRoots(loaded)
  const mayRunAgent = codingSessionsDigestMatches(loaded)
  if (!mayRunAgent) log('the configuration no longer matches its reviewed digest; agents will not start')
  const context: HostContext = {
    control: createCodingProcessControl(),
    loaded, meta, paths, log, mayRunAgent, roots,
    projector: createProjector(roots.rewriter),
  }
  const runtimeDigest = await executorRuntimeDigest(resolveExecutorEntry())
  for (;;) {
    const lock = await acquireHostLock(paths.lock, runtimeDigest)
    if (!lock) return
    // The host the bridge asked for has arrived; from here on the lock speaks for it.
    await unlink(paths.spawnMarker).catch(() => undefined)
    let done: boolean
    try {
      done = await serveSession(context, lock)
    } finally {
      await lock.release()
    }
    if (!done && await inboxHasRequests(paths)) continue
    // A closed session's unit is stopped, so nothing its agent started outlives it.
    if ((await readJson<CodingSessionState>(paths.state))?.status === 'closed') await stopOwnUserUnit()
    return
  }
}
