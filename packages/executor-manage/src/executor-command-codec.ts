import { createHash } from 'node:crypto'

import { decryptWithKey, deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import { canonicalExecutorJson } from '@nessie/schemas'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

export const executorCommandDigest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

export const encryptExecutorCommandJson = (
  encryptionSecret: string,
  value: unknown,
): string => JSON.stringify(
  encryptWithKey(deriveSecretKey(encryptionSecret), JSON.stringify(value)),
)

export const decryptExecutorCommandJson = (
  encryptionSecret: string,
  ciphertext: string,
): Record<string, unknown> => {
  try {
    const parts = JSON.parse(ciphertext) as {
      authTag: string
      ciphertext: string
      iv: string
    }
    const parsed = JSON.parse(decryptWithKey(deriveSecretKey(encryptionSecret), parts))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a record')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_PAYLOAD_INVALID,
      'Executor command payload cannot be read.',
    )
  }
}
