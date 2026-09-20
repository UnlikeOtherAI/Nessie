import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  ExecutorCommandEnvelopeSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import { ExecutorApiError } from './api-client.js'
import { assertOwnerOnlyStatePath } from './state-security.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'

const JOURNAL_FILE = 'command-recovery.json'
const UNKNOWN_OUTCOME_RESULT = {
  code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
  success: false,
}

type ReceiptState = 'accepted' | 'started' | 'result_acknowledged'

export type ExecutorCommandRecovery = {
  command: ExecutorCommandEnvelope
  phase: 'accepted_pending' | 'started_pending' | 'executing' | 'result_pending'
  result?: Record<string, unknown>
  version: 1
}

export type ExecutorCommandRecoveryStore = {
  clear: () => Promise<void>
  load: () => Promise<ExecutorCommandRecovery | null>
  save: (recovery: ExecutorCommandRecovery) => Promise<void>
}

export type ExecutorCommandRecoveryTransport = {
  poll: () => Promise<ExecutorCommandEnvelope | null>
  receipt: (input: {
    commandId: ExecutorCommandEnvelope['commandId']
    result?: Record<string, unknown>
    state: ReceiptState
  }) => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const parseRecovery = (value: unknown): ExecutorCommandRecovery => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Executor command recovery journal is malformed.')
  }
  const command = ExecutorCommandEnvelopeSchema.safeParse(value.command)
  const phase = value.phase
  if (
    !command.success
    || !['accepted_pending', 'started_pending', 'executing', 'result_pending'].includes(String(phase))
    || (phase === 'result_pending' && (!isRecord(value.result) || Object.keys(value.result).length === 0))
    || (phase !== 'result_pending' && value.result !== undefined)
  ) {
    throw new Error('Executor command recovery journal is malformed.')
  }
  return {
    command: command.data,
    phase: phase as ExecutorCommandRecovery['phase'],
    ...(phase === 'result_pending' ? { result: value.result as Record<string, unknown> } : {}),
    version: 1,
  }
}

export type ExecutorCommandRecoveryStoreDeps = {
  ensureRuntimeDirectory?: (stateDir: string) => Promise<string>
}

/**
 * The journal is local control state, not a second server queue. It lives under
 * the same owner-only boundary as the machine key and is atomically replaced.
 *
 * One store secures the runtime directory **once**, not once per operation.
 * Securing it creates and re-applies an explicit DACL, which on Windows means
 * spawning the packaged native helper twice; the daemon polls once a second, so
 * deriving the journal path per operation cost two process creations a second
 * for the life of the daemon and burned roughly fifty times the CPU its macOS
 * counterpart did, where the same proof is an `lstat`. It is setup, not a
 * per-operation proof: every `load` and `save` below still proves the journal
 * *file* owner-only before this process reads or replaces its contents, which
 * is the check that stands between the daemon and content someone else wrote.
 */
export const createExecutorCommandRecoveryStore = (
  stateDir: string,
  deps: ExecutorCommandRecoveryStoreDeps = {},
): ExecutorCommandRecoveryStore => {
  const ensureRuntimeDirectory = deps.ensureRuntimeDirectory ?? ensureExecutorRuntimeDirectory
  let secured: Promise<string> | undefined
  const journalPath = async (): Promise<string> => {
    // A rejected promise must never be the cached answer: a directory that
    // could not be secured once has to be attempted again, or one transient
    // failure would disable recovery for as long as the daemon runs.
    secured ??= ensureRuntimeDirectory(stateDir)
    try {
      return resolve(await secured, JOURNAL_FILE)
    } catch (error) {
      secured = undefined
      throw error
    }
  }

  return {
    clear: async () => {
      const path = await journalPath()
      try {
        await assertOwnerOnlyStatePath(path, 'file')
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    load: async () => {
      const path = await journalPath()
      try {
        await assertOwnerOnlyStatePath(path, 'file')
        return parseRecovery(JSON.parse(await readFile(path, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    save: async (recovery) => {
      const path = await journalPath()
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(`${JSON.stringify(recovery)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await assertOwnerOnlyStatePath(temporaryPath, 'file')
        await rename(temporaryPath, path)
      } finally {
        await unlink(temporaryPath).catch(() => undefined)
      }
    },
  }
}

const terminalUnknownOutcome = (
  recovery: ExecutorCommandRecovery,
): ExecutorCommandRecovery => ({
  command: recovery.command,
  phase: 'result_pending',
  result: UNKNOWN_OUTCOME_RESULT,
  version: 1,
})

const receiptWasFencedByUnknownOutcome = (error: unknown): boolean => (
  error instanceof ExecutorApiError && error.code === 'EXECUTOR_COMMAND_REPLAY'
)

/**
 * Advance one command to a durable terminal receipt. A response may disappear
 * after the server commits any receipt; retrying that same transition is safe.
 * A process death after execution begins is deliberately not retried: the
 * replacement daemon reports an unknown outcome so a side effect cannot run
 * twice.
 */
export const recoverOrPollExecutorCommand = async (input: {
  execute: (command: ExecutorCommandEnvelope) => Promise<Record<string, unknown>>
  store: ExecutorCommandRecoveryStore
  transport: ExecutorCommandRecoveryTransport
}): Promise<boolean> => {
  let recovery = await input.store.load()
  let executionStartedHere = false
  if (!recovery) {
    const command = await input.transport.poll()
    if (!command) return false
    recovery = { command, phase: 'accepted_pending', version: 1 }
    await input.store.save(recovery)
  }

  if (recovery.phase === 'accepted_pending') {
    try {
      await input.transport.receipt({ commandId: recovery.command.commandId, state: 'accepted' })
    } catch (error) {
      if (!receiptWasFencedByUnknownOutcome(error)) throw error
      recovery = terminalUnknownOutcome(recovery)
      await input.store.save(recovery)
    }
    if (recovery.phase === 'accepted_pending') {
      recovery = { ...recovery, phase: 'started_pending' }
      await input.store.save(recovery)
    }
  }

  if (recovery.phase === 'started_pending') {
    try {
      await input.transport.receipt({ commandId: recovery.command.commandId, state: 'started' })
    } catch (error) {
      if (!receiptWasFencedByUnknownOutcome(error)) throw error
      recovery = terminalUnknownOutcome(recovery)
      await input.store.save(recovery)
    }
    if (recovery.phase === 'started_pending') {
      recovery = { ...recovery, phase: 'executing' }
      await input.store.save(recovery)
      executionStartedHere = true
    }
  }

  if (recovery.phase === 'executing') {
    const result = executionStartedHere
      ? await input.execute(recovery.command)
      : UNKNOWN_OUTCOME_RESULT
    recovery = { command: recovery.command, phase: 'result_pending', result, version: 1 }
    await input.store.save(recovery)
  }

  if (recovery.phase === 'result_pending') {
    await input.transport.receipt({
      commandId: recovery.command.commandId,
      result: recovery.result,
      state: 'result_acknowledged',
    })
    await input.store.clear()
  }
  return true
}
