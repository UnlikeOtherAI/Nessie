import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { canonicalExecutorJson } from '@nessie/schemas'

import {
  createExecutorCommand,
  pollExecutorCommand,
  readExecutorCommandResult,
  recordExecutorCommandReceipt,
} from '../src/index.js'

const commandId = '00000000-0000-4000-8000-000000000001'
const bindingId = '00000000-0000-4000-8000-000000000002'
const executorId = '00000000-0000-4000-8000-000000000003'
const queueJobId = '00000000-0000-4000-8000-000000000004'
const toolCallId = '00000000-0000-4000-8000-000000000005'
const secret = 'command-encryption-secret'

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

test('command payload and terminal result are encrypted at rest and receipt transitions are ordered', async () => {
  const state: Record<string, unknown> = {
    binding: {
      capabilityRevision: { revision: 1 },
      fence: BigInt(7),
      operationKey: 'sandbox.stop',
    },
    payloadExpiresAt: new Date('2026-08-12T12:05:00.000Z'),
    queueJob: { status: 'processing' },
    state: 'leased',
  }
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return data
      },
      findFirst: async () => state,
      findUnique: async () => ({ ...state, binding: { executorId } }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return state
      },
    },
  } as unknown as PrismaClient
  const payload = { requestedBy: 'agent', stopReason: 'user_cancelled' }
  await createExecutorCommand(prisma, {
    bindingId,
    commandId,
    encryptionSecret: secret,
    expiresAt: state.payloadExpiresAt as Date,
    payload,
    queueJobId,
    toolCallId,
  })

  assert.equal((state.deliveryPayloadCiphertext as string).includes('user_cancelled'), false)
  const envelope = await pollExecutorCommand(
    prisma,
    secret,
    executorId,
    new Date('2026-08-12T12:00:00.000Z'),
  )
  assert.deepEqual(envelope?.payload, payload)
  assert.equal(envelope?.bindingFence, '7')

  const at = '2026-08-12T12:00:01.000Z'
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    state: 'accepted',
  }, undefined)
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    state: 'started',
  }, undefined)
  const result = { status: 'no_active_sandbox', success: true }
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)

  assert.equal((state.resultCiphertext as string).includes('no_active_sandbox'), false)
  assert.deepEqual(await readExecutorCommandResult(prisma, secret, commandId), result)
})

test('a terminal command receipt cannot be replaced by a different result', async () => {
  const state = {
    binding: { executorId },
    resultDigest: digest({ success: true }),
    state: 'result_acknowledged',
  }
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: { findUnique: async () => state },
  } as unknown as PrismaClient
  await assert.rejects(
    recordExecutorCommandReceipt(prisma, secret, executorId, {
      commandId,
      occurredAt: '2026-08-12T12:00:01.000Z',
      resultDigest: digest({ success: false }),
      state: 'result_acknowledged',
    }, { success: false }),
    { code: 'EXECUTOR_COMMAND_REPLAY' },
  )
})
