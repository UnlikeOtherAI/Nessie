import type { PrismaClient } from '@prisma/client'
import type { ExecutorCommandEnvelope } from '@nessie/schemas'

import {
  pollExecutorCommandInTransaction,
} from './executor-commands.js'
import {
  recordExecutorCommandReceiptInTransaction,
} from './executor-command-results.js'
import { authorizeExecutorDaemonControlCall } from './executor-daemon.js'

type DaemonControlIdentity = {
  connectionEpoch: string
  executorId: string
  signature: string
}

type DaemonPollInput = DaemonControlIdentity & { observedAt: string }

type DaemonReceiptInput = DaemonControlIdentity & {
  receipt: {
    commandId: string
    occurredAt: string
    resultDigest?: string
    state: 'accepted' | 'started' | 'result_acknowledged'
  }
  result?: Record<string, unknown>
}

export const pollAuthorizedExecutorCommand = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  input: DaemonPollInput,
  now = new Date(),
): Promise<ExecutorCommandEnvelope | null> => authorizeExecutorDaemonControlCall(
  prisma,
  {
    ...input,
    payload: {
      connectionEpoch: input.connectionEpoch,
      executorId: input.executorId,
      observedAt: input.observedAt,
    },
    type: 'poll',
  },
  (tx) => pollExecutorCommandInTransaction(tx, encryptionSecret, input.executorId, now),
  now,
)

export const recordAuthorizedExecutorCommandReceipt = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  input: DaemonReceiptInput,
  now = new Date(),
): Promise<void> => authorizeExecutorDaemonControlCall(
  prisma,
  {
    connectionEpoch: input.connectionEpoch,
    executorId: input.executorId,
    observedAt: input.receipt.occurredAt,
    payload: {
      connectionEpoch: input.connectionEpoch,
      executorId: input.executorId,
      receipt: input.receipt,
    },
    signature: input.signature,
    type: 'receipt',
  },
  (tx) => recordExecutorCommandReceiptInTransaction(
    tx,
    encryptionSecret,
    input.executorId,
    input.receipt,
    input.result,
  ),
  now,
)
