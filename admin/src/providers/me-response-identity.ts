import type { MeResponse } from '@nessie/schemas'

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (
    typeof left !== 'object' || left === null
    || typeof right !== 'object' || right === null
  ) {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
  )
}

/**
 * Whether two `/me` responses say the same thing.
 *
 * `MeResponse` is the most widely read object in the admin — every
 * `useAuthSession()` consumer re-renders when its identity changes — and the
 * responses that arrive most often (a poll, a preference PATCH echo) usually
 * carry no change at all. Comparing by value keeps identity stable across
 * those, so a re-render means something about the person, their session, or
 * their team actually moved.
 *
 * Structural rather than a revision counter because the API publishes no
 * revision. A false negative only costs the re-render that happens today.
 */
export const isSameMeResponse = (
  left: MeResponse | null,
  right: MeResponse | null,
): boolean => sameValue(left, right)
