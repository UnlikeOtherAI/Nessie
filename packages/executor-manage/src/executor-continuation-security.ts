import { createHash, timingSafeEqual } from 'node:crypto'

import { canonicalExecutorJson } from './executor-canonical-json.js'

export const EXECUTOR_CONTINUATION_TTL_MS = 10 * 60 * 1000

export const hashExecutorContinuationValue = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export const executorContinuationValuesMatch = (value: string, expected: string | null): boolean => {
  if (!expected) return false
  const actual = Buffer.from(value)
  const target = Buffer.from(expected)
  return actual.length === target.length && timingSafeEqual(actual, target)
}

export const executorContinuationSubjectDigest = (value: unknown): string =>
  hashExecutorContinuationValue(canonicalExecutorJson(value))
