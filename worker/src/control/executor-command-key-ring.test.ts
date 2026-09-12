import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { AT_REST_SECRET_PURPOSE, encryptWithKeyRing } from '@nessie/runtime'

import { executeExecutorCommandJob } from './executor-commands.js'

const commandId = '00000000-0000-4000-8000-000000000121'
const encryptionKeyRing = {
  activeVersion: '2026-09',
  keys: { '2026-09': 'executor-command-dedicated-encryption-root' },
}

const apiDaemonRoutes = readFileSync(
  new URL('../../../api/src/routes/executor-daemon-routes.ts', import.meta.url),
  'utf8',
)

test('API daemon receipts and the worker command job use the dedicated key ring', async () => {
  assert.match(
    apiDaemonRoutes,
    /pollAuthorizedExecutorCommand\(prisma, deps\.encryptionKeyRing, body\)/,
  )
  assert.match(
    apiDaemonRoutes,
    /recordAuthorizedExecutorCommandReceipt\(prisma, deps\.encryptionKeyRing, body\)/,
  )

  const resultCiphertext = JSON.stringify(encryptWithKeyRing(
    encryptionKeyRing,
    AT_REST_SECRET_PURPOSE.executorCommand,
    JSON.stringify({ status: 'completed', success: true }),
  ))
  let reads = 0
  const prisma = {
    executorCommand: {
      findUnique: async () => {
        reads += 1
        return reads === 1
          ? { payloadExpiresAt: new Date(Date.now() + 1_000), state: 'leased' }
          : { resultCiphertext, state: 'result_acknowledged' }
      },
    },
  } as unknown as PrismaClient

  await executeExecutorCommandJob(prisma, encryptionKeyRing, { commandId })
  assert.equal(reads, 2)

  reads = 0
  await assert.rejects(
    executeExecutorCommandJob(prisma, 'auth-token-signing-secret', { commandId }),
    /Executor command payload cannot be read/,
  )
})
