import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/schemas'

import { ExecutorApiError } from '../src/api-client.js'
import {
  createExecutorCommandRecoveryStore,
  recoverOrPollExecutorCommand,
  type ExecutorCommandRecovery,
  type ExecutorCommandRecoveryStore,
  type ExecutorCommandRecoveryTransport,
} from '../src/command-recovery.js'

const command: ExecutorCommandEnvelope = {
  argumentDigest: `sha256:${'1'.repeat(64)}`,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000502',
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000503',
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'command-recovery-test',
  operationKey: 'command.run',
  payload: { args: { args: ['test'], program: 'pnpm' }, runId: '00000000-0000-4000-8000-000000000501' },
}

const memoryStore = (initial: ExecutorCommandRecovery | null = null): {
  read: () => ExecutorCommandRecovery | null
  store: ExecutorCommandRecoveryStore
} => {
  let value = initial
  return {
    read: () => value,
    store: {
      clear: async () => { value = null },
      load: async () => value,
      save: async (next) => { value = structuredClone(next) },
    },
  }
}

type ServerState = 'leased' | 'accepted' | 'started' | 'result_acknowledged' | 'unknown_outcome'

const fakeTransport = (options: {
  dropAfter?: 'accepted' | 'started' | 'result_acknowledged'
  initialState?: ServerState
} = {}): {
  pollCount: () => number
  result: () => Record<string, unknown> | undefined
  state: () => ServerState
  transport: ExecutorCommandRecoveryTransport
} => {
  let state: ServerState = options.initialState ?? 'leased'
  let delivered = false
  let polls = 0
  let result: Record<string, unknown> | undefined
  const receiptCalls = new Map<string, number>()
  return {
    pollCount: () => polls,
    result: () => result,
    state: () => state,
    transport: {
      poll: async () => {
        polls += 1
        if (delivered || state !== 'leased') return null
        delivered = true
        return command
      },
      receipt: async (receipt) => {
        const currentCalls = receiptCalls.get(receipt.state) ?? 0
        receiptCalls.set(receipt.state, currentCalls + 1)
        const same = state === receipt.state
        const valid = (
          (state === 'leased' && receipt.state === 'accepted')
          || (state === 'accepted' && receipt.state === 'started')
          || (state === 'started' && receipt.state === 'result_acknowledged')
          || (state === 'unknown_outcome' && receipt.state === 'result_acknowledged')
        )
        if (!same && !valid) {
          throw new ExecutorApiError('Receipt is out of order.', {
            code: 'EXECUTOR_COMMAND_REPLAY',
            status: 409,
          })
        }
        state = receipt.state
        if (receipt.result) result = receipt.result
        if (options.dropAfter === receipt.state && currentCalls === 0) {
          throw new Error(`response lost after ${receipt.state}`)
        }
      },
    },
  }
}

for (const lossPoint of ['accepted', 'started', 'result_acknowledged'] as const) {
  test(`client-recovery: lost ${lossPoint} response is replayed without repeated execution`, async () => {
    const journal = memoryStore()
    const server = fakeTransport({ dropAfter: lossPoint })
    let executions = 0
    const run = () => recoverOrPollExecutorCommand({
      execute: async () => {
        executions += 1
        return { exitCode: 0, output: 'done', success: true }
      },
      store: journal.store,
      transport: server.transport,
    })

    await assert.rejects(run(), new RegExp(`response lost after ${lossPoint}`))
    await run()

    assert.equal(server.state(), 'result_acknowledged')
    assert.equal(server.pollCount(), 1)
    assert.equal(executions, 1)
    assert.equal(journal.read(), null)
    assert.deepEqual(server.result(), { exitCode: 0, output: 'done', success: true })
  })
}

test('client-recovery: restart during execution reports unknown outcome without rerun', async () => {
  const journal = memoryStore({ command, phase: 'executing', version: 1 })
  const server = fakeTransport({ initialState: 'started' })
  let executions = 0
  await recoverOrPollExecutorCommand({
    execute: async () => {
      executions += 1
      return { success: true }
    },
    store: journal.store,
    transport: server.transport,
  })

  assert.equal(executions, 0)
  assert.equal(server.state(), 'result_acknowledged')
  assert.deepEqual(server.result(), {
    code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
    success: false,
  })
})

test('client-recovery: server timeout before execution resolves as unknown outcome', async () => {
  const journal = memoryStore({ command, phase: 'started_pending', version: 1 })
  const server = fakeTransport({ initialState: 'unknown_outcome' })
  let executions = 0
  await recoverOrPollExecutorCommand({
    execute: async () => {
      executions += 1
      return { success: true }
    },
    store: journal.store,
    transport: server.transport,
  })

  assert.equal(executions, 0)
  assert.equal(server.state(), 'result_acknowledged')
  assert.deepEqual(server.result(), {
    code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
    success: false,
  })
})

const withStateDirectory = async (body: (stateDir: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-command-recovery-'))
  try {
    await body(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

/**
 * The daemon polls once a second and used to build a recovery store per poll,
 * each of which re-secured the runtime directory. On POSIX that is an `lstat`;
 * on Windows it applies a DACL through the packaged native helper, so it was
 * two process spawns every second for as long as the daemon ran — the reason a
 * Windows executor burned roughly fifty times the CPU of its macOS counterpart
 * while both sat idle. One store now secures once, however many operations it
 * serves.
 *
 * Only `load` and `clear` are exercised, because `save` proves the journal file
 * itself owner-only and that proof is host-shaped; every operation derives the
 * path the same way, which is the thing under test.
 */
test('one recovery store secures its runtime directory once, not once per operation', async () => {
  await withStateDirectory(async (stateDir) => {
    let ensured = 0
    const store = createExecutorCommandRecoveryStore(stateDir, {
      ensureRuntimeDirectory: async (directory) => {
        ensured += 1
        return directory
      },
    })

    assert.equal(await store.load(), null)
    await store.clear()
    assert.equal(await store.load(), null)
    await store.clear()

    assert.equal(ensured, 1)
  })
})

/**
 * Securing once means caching the promise, which makes a rejected one
 * dangerous: cache that and a single transient failure would leave the daemon
 * unable to journal anything for the rest of its life, silently losing command
 * recovery. A failure must be attempted again on the next operation.
 */
test('a runtime directory that could not be secured is attempted again', async () => {
  await withStateDirectory(async (stateDir) => {
    let attempts = 0
    const store = createExecutorCommandRecoveryStore(stateDir, {
      ensureRuntimeDirectory: async (directory) => {
        attempts += 1
        if (attempts === 1) throw new Error('state security timed out')
        return directory
      },
    })

    await assert.rejects(store.load(), /state security timed out/)
    assert.equal(await store.load(), null)
    assert.equal(attempts, 2)
  })
})
