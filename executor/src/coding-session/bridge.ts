import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  argumentsFor,
  CodingBridgeError,
  invalidArguments,
  requiredText,
  sessionIdArgument,
} from './bridge-tools.js'
import { codingSessionsDigestMatches, type LoadedCodingSessionsConfig } from './config.js'
import { ensureCodingSessionHost, resolveExecutorEntry } from './host-spawn.js'
import { reviewCodingSession } from './review.js'
import {
  CodingRootError,
  findCodingRoot,
  normalizeCodingPath,
  resolveCodingFolder,
  resolveCodingRoots,
  type CodingRootSet,
} from './roots.js'
import { parseEventCursor } from './session-events.js'
import {
  codingCommandsDir,
  codingSessionPaths,
  codingSessionsDir,
  createJsonExclusive,
  ensureCodingStateDir,
  ensurePrivateDir,
  readJson,
  type CodingSessionPaths,
} from './session-files.js'
import {
  claimCommand,
  COMMAND_ID_PATTERN,
  listSessionMetas,
  pruneCommandRecords,
  readSessionMeta,
  writeRequest,
  type CommandRecord,
} from './session-requests.js'
import { composeCodingStatus, deriveCodingStatus } from './status.js'
import {
  codingSessionIsLive,
  type CodingAgentName,
  type CodingSessionMeta,
  type CodingSessionState,
} from './types.js'

/**
 * The stateless half of coding sessions: every call reads what it needs from
 * the state directory, writes a request if it has to, makes sure a host is
 * alive, and answers in well under five seconds (a review has its own 20 s).
 *
 * Owners are structural. The daemon names the owner of every call in the
 * reserved `_meta['nessie/owner']`, which the model cannot reach; a call
 * without one is refused, `session_list` shows only the caller's sessions,
 * and every other tool answers "No such session" for somebody else's.
 */
export type CodingBridgeCallMeta = {
  ownerKey?: string
  commandId?: string
  daemonControl: boolean
}

export type CodingBridge = {
  call: (tool: string, args: unknown, meta: CodingBridgeCallMeta) => Promise<Record<string, unknown>>
  rewrite: (text: string) => string
}

const OWNER_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/u

const titleFrom = (prompt: string): string => {
  const first = prompt.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? 'Coding session'
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

export const createCodingBridge = async (loaded: LoadedCodingSessionsConfig): Promise<CodingBridge> => {
  const rootSet: CodingRootSet = await resolveCodingRoots(loaded)
  await ensureCodingStateDir(loaded.stateDir)
  await ensurePrivateDir(codingSessionsDir(loaded.stateDir))
  await ensurePrivateDir(codingCommandsDir(loaded.stateDir))
  void pruneCommandRecords(loaded.stateDir).catch(() => undefined)
  const entry = resolveExecutorEntry()
  const { stateDir } = loaded

  const owner = (meta: CodingBridgeCallMeta): string => {
    if (!meta.ownerKey || !OWNER_KEY_PATTERN.test(meta.ownerKey)) {
      throw new CodingBridgeError(
        'coding_session_owner_missing',
        'This call names no owner. Coding sessions are reached only through Nessie, which names the owner of every call.',
      )
    }
    return meta.ownerKey
  }

  const commandIdOf = (meta: CodingBridgeCallMeta): string => (
    meta.commandId && COMMAND_ID_PATTERN.test(meta.commandId) ? meta.commandId : randomUUID()
  )

  const owned = async (
    sessionId: unknown, ownerKey: string,
  ): Promise<{ paths: CodingSessionPaths; meta: CodingSessionMeta }> => {
    const paths = codingSessionPaths(stateDir, sessionIdArgument(sessionId))
    const meta = await readSessionMeta(paths)
    if (!meta || meta.ownerKey !== ownerKey) throw new CodingBridgeError('coding_session_not_found', 'No such session.')
    return { paths, meta }
  }

  const readState = (paths: CodingSessionPaths) => readJson<CodingSessionState>(paths.state)

  const requireReviewedConfig = (): void => {
    if (!codingSessionsDigestMatches(loaded)) {
      throw new CodingBridgeError(
        'coding_session_config_changed',
        'The coding-sessions configuration on this machine changed since it was reviewed. '
        + 'A person has to review the executor policy again before sessions can start or continue.',
      )
    }
  }

  const ensureHost = (paths: CodingSessionPaths, sessionId: string) => ensureCodingSessionHost({
    configPath: loaded.configPath, entry, paths, sessionId,
  })

  /** A command id seen before returns the first outcome and does nothing else. */
  const replayed = async (commandId: string, ownerKey: string): Promise<CommandRecord | undefined> => {
    const existing = await readJson<CommandRecord>(join(codingCommandsDir(stateDir), `${commandId}.json`))
    if (existing && existing.ownerKey !== ownerKey) throw new CodingBridgeError('coding_session_not_found', 'No such session.')
    return existing
  }

  const briefStatus = async (paths: CodingSessionPaths) => {
    const derived = await deriveCodingStatus(paths, await readState(paths))
    return { status: derived.status, ...(derived.reason ? { reason: derived.reason } : {}) }
  }

  const list = async (ownerKey: string): Promise<Record<string, unknown>> => {
    const metas = (await listSessionMetas(stateDir)).filter((meta) => meta.ownerKey === ownerKey)
    const sessions = []
    for (const meta of metas) {
      const paths = codingSessionPaths(stateDir, meta.sessionId)
      const state = await readState(paths)
      const derived = await deriveCodingStatus(paths, state)
      sessions.push({
        sessionId: meta.sessionId, title: meta.title, status: derived.status,
        ...(derived.reason ? { reason: derived.reason } : {}),
        agent: meta.agent, root: meta.rootName, path: meta.path, turn: state?.turn ?? 0,
        updatedAt: state?.updatedAt ?? meta.createdAt,
      })
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      roots: rootSet.roots.map((root) => ({ name: root.name, available: root.canonical !== undefined })),
      agents: Object.keys(loaded.config.agents),
      sessions: sessions.slice(0, 30),
    }
  }

  const start = async (value: unknown, ownerKey: string, commandId: string): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, ['agent', 'root', 'path', 'prompt', 'title'])
    const agent = args.agent as CodingAgentName
    if (typeof agent !== 'string' || !loaded.config.agents[agent]) {
      invalidArguments(`agent must be one of: ${Object.keys(loaded.config.agents).join(', ')}.`)
    }
    const root = findCodingRoot(rootSet, args.root)
    const path = normalizeCodingPath(args.path)
    await resolveCodingFolder(root, path)
    const prompt = requiredText(args.prompt, 'prompt', 32_000)
    const title = args.title === undefined ? titleFrom(prompt) : requiredText(args.title, 'title', 120).trim()
    requireReviewedConfig()
    const previous = await replayed(commandId, ownerKey)
    if (previous) {
      const paths = codingSessionPaths(stateDir, previous.sessionId)
      return { sessionId: previous.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const live = []
    for (const meta of await listSessionMetas(stateDir)) {
      if (meta.ownerKey !== ownerKey) continue
      const paths = codingSessionPaths(stateDir, meta.sessionId)
      if (codingSessionIsLive((await deriveCodingStatus(paths, await readState(paths))).status)) live.push(meta)
    }
    if (live.length >= loaded.config.maxLiveSessionsPerOwner) {
      throw new CodingBridgeError(
        'coding_session_quota_exceeded',
        `You already have ${live.length} open coding sessions on this machine, the most it allows. Close one first.`,
      )
    }
    const sessionId = randomUUID()
    const claimed = await claimCommand(stateDir, { commandId, ownerKey, tool: 'session_start', sessionId, at: new Date().toISOString() })
    if (claimed) {
      const paths = codingSessionPaths(stateDir, claimed.sessionId)
      return { sessionId: claimed.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const paths = codingSessionPaths(stateDir, sessionId)
    await mkdir(paths.inbox, { recursive: true, mode: 0o700 })
    const meta: CodingSessionMeta = {
      version: 1, sessionId, ownerKey, agent, rootName: root.name, path, title, createdAt: new Date().toISOString(),
    }
    await createJsonExclusive(paths.meta, meta)
    await writeRequest(paths, { id: commandId, kind: 'start', text: prompt, at: meta.createdAt })
    await ensureHost(paths, sessionId)
    return { sessionId, status: 'starting', agent, root: root.name, path, title }
  }

  /** send, interrupt and close: one request per executor command, then a live host. */
  const request = async (
    kind: 'send' | 'interrupt' | 'close', value: unknown, ownerKey: string, commandId: string,
  ): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, kind === 'send' ? ['sessionId', 'message'] : ['sessionId'])
    const { paths, meta } = await owned(args.sessionId, ownerKey)
    const text = kind === 'send' ? requiredText(args.message, 'message', 32_000) : undefined
    if (kind === 'send') requireReviewedConfig()
    if (await replayed(commandId, ownerKey)) {
      return { sessionId: meta.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const state = await readState(paths)
    const derived = await deriveCodingStatus(paths, state)
    if (derived.status === 'closed') {
      if (kind === 'close') return { sessionId: meta.sessionId, status: 'closed' }
      throw new CodingBridgeError('coding_session_closed', 'That session is closed. Start a new one.')
    }
    if (kind === 'send' && derived.status === 'failed') {
      throw new CodingBridgeError(
        'coding_session_failed',
        `That session failed (${derived.reason ?? 'unknown'}) and cannot continue. Start a new one once the cause is fixed.`,
      )
    }
    // Nothing is running to interrupt: no live host, and no agent a lost host may have left behind.
    if (kind === 'interrupt' && !derived.hostLive && !derived.hostStarting && derived.reason !== 'host_lost') {
      return { sessionId: meta.sessionId, status: derived.status, interrupted: false }
    }
    await claimCommand(stateDir, { commandId, ownerKey, tool: `session_${kind}`, sessionId: meta.sessionId, at: new Date().toISOString() })
    const at = new Date().toISOString()
    await writeRequest(paths, { id: commandId, kind, ...(text === undefined ? {} : { text }), at })
    await ensureHost(paths, meta.sessionId)
    return {
      sessionId: meta.sessionId,
      status: kind === 'close' ? 'closing' : derived.status,
      ...(kind === 'send' ? { queued: true } : {}),
      ...(kind === 'interrupt' ? { interrupted: true } : {}),
    }
  }

  const status = async (value: unknown, ownerKey: string): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, ['sessionId', 'detail', 'cursor'])
    const { paths, meta } = await owned(args.sessionId, ownerKey)
    if (args.detail !== undefined && args.detail !== 'summary' && args.detail !== 'events') {
      invalidArguments('detail must be summary or events.')
    }
    const cursor = args.cursor === undefined ? undefined : parseEventCursor(args.cursor)
    if (args.cursor !== undefined && !cursor) invalidArguments('cursor must be a nextCursor this tool returned.')
    const state = await readState(paths)
    const derived = await deriveCodingStatus(paths, state)
    // A lost host with requests still waiting gets a successor, so the next read sees them delivered.
    if (derived.reason === 'host_lost' && derived.inboxPending > 0 && codingSessionsDigestMatches(loaded)) {
      await ensureHost(paths, meta.sessionId)
    }
    return composeCodingStatus({
      paths, meta, state, derived, detail: (args.detail ?? 'summary') as 'summary' | 'events', ...(cursor ? { cursor } : {}),
    })
  }

  const review = async (value: unknown, ownerKey: string): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, ['sessionId'])
    const { paths, meta } = await owned(args.sessionId, ownerKey)
    const root = findCodingRoot(rootSet, meta.rootName)
    const folder = await resolveCodingFolder(root, meta.path)
    const state = await readState(paths)
    return {
      sessionId: meta.sessionId,
      ...await briefStatus(paths),
      ...await reviewCodingSession({ folder, rootCanonical: root.canonical!, rewriter: rootSet.rewriter, state }),
    }
  }

  /** The daemon's teardown: close every session, or one owner's, wherever the daemon already stops work. */
  const closeAll = async (
    value: unknown, meta: CodingBridgeCallMeta, commandId: string,
  ): Promise<Record<string, unknown>> => {
    if (!meta.daemonControl) {
      throw new CodingBridgeError('coding_session_daemon_only', 'Only the executor daemon may close every session.')
    }
    const args = argumentsFor(value, ['ownerKey', 'reason'])
    if (args.ownerKey !== undefined && (typeof args.ownerKey !== 'string' || !OWNER_KEY_PATTERN.test(args.ownerKey))) {
      invalidArguments('ownerKey must be an owner key.')
    }
    requiredText(args.reason, 'reason', 200)
    let closing = 0
    for (const session of await listSessionMetas(stateDir)) {
      if (args.ownerKey !== undefined && session.ownerKey !== args.ownerKey) continue
      const paths = codingSessionPaths(stateDir, session.sessionId)
      const derived = await deriveCodingStatus(paths, await readState(paths))
      if (derived.status === 'closed') continue
      await writeRequest(paths, { id: `close-all-${commandId}`.slice(0, 128), kind: 'close', at: new Date().toISOString() })
      await ensureHost(paths, session.sessionId)
      closing += 1
    }
    return { closing }
  }

  return {
    rewrite: rootSet.rewriter.rewrite,
    call: async (tool, args, meta) => {
      try {
        const commandId = commandIdOf(meta)
        if (tool === 'session_close_all') return await closeAll(args, meta, commandId)
        const ownerKey = owner(meta)
        if (tool === 'session_list') {
          argumentsFor(args, [])
          return await list(ownerKey)
        }
        if (tool === 'session_start') return await start(args, ownerKey, commandId)
        if (tool === 'session_status') return await status(args, ownerKey)
        if (tool === 'session_send') return await request('send', args, ownerKey, commandId)
        if (tool === 'session_interrupt') return await request('interrupt', args, ownerKey, commandId)
        if (tool === 'session_close') return await request('close', args, ownerKey, commandId)
        if (tool === 'session_review') return await review(args, ownerKey)
        throw new CodingBridgeError('coding_session_unknown_tool', 'That is not a coding-sessions tool.')
      } catch (error) {
        if (error instanceof CodingRootError) throw new CodingBridgeError(`coding_session_${error.code}`, error.message)
        throw error
      }
    },
  }
}
