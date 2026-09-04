import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import {
  authorizeExecutorDaemonControlCall,
  canonicalExecutorPayload,
  claimExecutorConnection,
  ExecutorError,
} from '../src/index.js'

const executorId = '00000000-0000-4000-8000-000000000001'
const observedAt = '2026-08-12T12:00:00.000Z'
const now = new Date(observedAt)

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const mutex = () => {
  let tail = Promise.resolve()
  return async (): Promise<() => void> => {
    const entered = deferred()
    const prior = tail
    tail = tail.then(() => entered.promise)
    await prior
    return entered.resolve
  }
}

const controlHarness = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const machinePublicKey = spki.subarray(-32).toString('base64url')
  const acquire = mutex()
  const state = {
    activeConnectionEpoch: 1n,
    id: executorId,
    lastSeenAt: now,
    machinePublicKey,
    status: 'online' as 'online' | 'offline',
  }
  let challengeUpdates = 0
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      let release: (() => void) | undefined
      const tx = {
        $executeRaw: async () => {
          release ??= await acquire()
          return 1
        },
        executor: {
          findUnique: async () => ({ ...state }),
          update: async ({ data }: {
            data: {
              activeConnectionEpoch?: { increment: number }
              lastSeenAt?: Date
              status?: 'online' | 'offline'
            }
          }) => {
            if (data.activeConnectionEpoch) {
              state.activeConnectionEpoch += BigInt(data.activeConnectionEpoch.increment)
            }
            if (data.lastSeenAt) state.lastSeenAt = data.lastSeenAt
            if (data.status) state.status = data.status
            return { ...state }
          },
          updateMany: async () => ({ count: 0 }),
        },
        executorDaemonChallenge: {
          updateMany: async () => {
            challengeUpdates += 1
            return { count: 1 }
          },
        },
      }
      try {
        return await callback(tx)
      } finally {
        release?.()
      }
    },
  } as unknown as PrismaClient
  const signedControl = (type: 'poll' | 'receipt') => {
    const receipt = {
      commandId: '00000000-0000-4000-8000-000000000002',
      occurredAt: observedAt,
      state: 'accepted',
    }
    const payload = type === 'poll'
      ? { connectionEpoch: '1', executorId, observedAt }
      : { connectionEpoch: '1', executorId, receipt }
    return {
      input: {
        connectionEpoch: '1',
        executorId,
        observedAt,
        payload,
        signature: sign(
          null,
          Buffer.from(canonicalExecutorPayload(
            `nessie.executor.daemon.${type}.v1`,
            payload,
          )),
          privateKey,
        ).toString('base64url'),
        type,
      },
      receipt,
    }
  }
  const claim = () => {
    const challenge = 'fresh-server-challenge'
    const payload = { challenge, executorId }
    return claimExecutorConnection(prisma, {
      challenge,
      executorId,
      signature: sign(
        null,
        Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.claim.v1', payload)),
        privateKey,
      ).toString('base64url'),
    })
  }
  return { challengeUpdates: () => challengeUpdates, claim, prisma, signedControl, state }
}

const assertEpochChangeWaitsFor = async (type: 'poll' | 'receipt') => {
  const harness = controlHarness()
  const actionEntered = deferred()
  const releaseAction = deferred()
  const control = harness.signedControl(type)
  const authorized = authorizeExecutorDaemonControlCall(
    harness.prisma,
    control.input,
    async () => {
      actionEntered.resolve()
      await releaseAction.promise
      return type === 'poll' ? 'command-1' : 'receipt-recorded'
    },
    now,
  )
  await actionEntered.promise

  const newerClaim = harness.claim()
  await nextTurn()
  assert.equal(harness.challengeUpdates(), 0)

  releaseAction.resolve()
  assert.equal(await authorized, type === 'poll' ? 'command-1' : 'receipt-recorded')
  assert.deepEqual(await newerClaim, { connectionEpoch: '2', status: 'online' })

  await assert.rejects(
    authorizeExecutorDaemonControlCall(
      harness.prisma,
      control.input,
      async () => 'must-not-run',
      now,
    ),
    (error: unknown) => error instanceof ExecutorError
      && error.code === 'EXECUTOR_CONNECTION_FENCED',
  )
}

test('an old-epoch poll cannot cross a concurrent daemon claim', async () => {
  await assertEpochChangeWaitsFor('poll')
})

test('an old-epoch receipt cannot cross a concurrent daemon claim', async () => {
  await assertEpochChangeWaitsFor('receipt')
})

test('duplicate concurrent polls serialize and recover the same leased command', async () => {
  const harness = controlHarness()
  const control = harness.signedControl('poll')
  const firstEntered = deferred()
  const releaseFirst = deferred()
  let active = 0
  let calls = 0
  let maxActive = 0
  const action = async () => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    if (calls === 1) {
      firstEntered.resolve()
      await releaseFirst.promise
    }
    active -= 1
    return 'command-1'
  }

  const first = authorizeExecutorDaemonControlCall(harness.prisma, control.input, action, now)
  await firstEntered.promise
  const duplicate = authorizeExecutorDaemonControlCall(harness.prisma, control.input, action, now)
  await nextTurn()
  assert.equal(calls, 1)

  releaseFirst.resolve()
  assert.deepEqual(await Promise.all([first, duplicate]), ['command-1', 'command-1'])
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
})
