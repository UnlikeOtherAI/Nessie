import { UoaBillingError } from './uoa-billing-client.js'

type UoaAction = {
  enabled: boolean
  disabled_reason: string | null
  id: string
  kind: string
  request: {
    body: Readonly<Record<string, unknown>>
    method: string
    path: string
  }
}

export const hasExactUoaActionBody = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean => {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => actual[key] === expected[key])
}

const containsBody = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean => Object.entries(expected).every(
  ([key, value]) => actual[key] === value,
)

export const requireUoaFrozenAction = <T extends UoaAction>(
  matches: readonly T[],
  expected: {
    body: Readonly<Record<string, unknown>>
    bodyMatch?: 'contains' | 'exact'
    id: string
    kind: string
    path: string
  },
): T => {
  const action = matches[0]
  if (
    matches.length !== 1
    || !action
    || action.id !== expected.id
    || action.kind !== expected.kind
    || action.request.method !== 'POST'
    || action.request.path !== expected.path
    || !(expected.bodyMatch === 'contains'
      ? containsBody
      : hasExactUoaActionBody)(
      action.request.body,
      expected.body,
    )
  ) {
    throw new UoaBillingError(
      'UOA_BILLING_ACTION_INVALID',
      'UnlikeOtherAI returned an invalid billing action.',
      502,
    )
  }
  if (!action.enabled) {
    throw new UoaBillingError(
      'UOA_BILLING_ACTION_UNAVAILABLE',
      action.disabled_reason ?? 'This billing action is unavailable.',
      409,
    )
  }
  return action
}
