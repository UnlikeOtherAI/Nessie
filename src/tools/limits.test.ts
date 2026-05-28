import { normalizePositiveLimit } from './limits.js'

describe('normalizePositiveLimit', () => {
  it('returns the value when it is a positive finite number', () => {
    expect(normalizePositiveLimit(10, 5)).toBe(10)
    expect(normalizePositiveLimit(1, 5)).toBe(1)
    expect(normalizePositiveLimit(100, 5)).toBe(100)
  })

  it('floors non-integer values', () => {
    expect(normalizePositiveLimit(10.9, 5)).toBe(10)
    expect(normalizePositiveLimit(1.1, 5)).toBe(1)
  })

  it('returns fallback for undefined', () => {
    expect(normalizePositiveLimit(undefined, 50)).toBe(50)
    expect(normalizePositiveLimit(undefined, 0)).toBe(0)
  })

  it('returns fallback for NaN', () => {
    expect(normalizePositiveLimit(NaN, 30)).toBe(30)
  })

  it('returns fallback for Infinity', () => {
    expect(normalizePositiveLimit(Infinity, 30)).toBe(30)
    expect(normalizePositiveLimit(-Infinity, 30)).toBe(30)
  })

  it('returns fallback for zero', () => {
    expect(normalizePositiveLimit(0, 10)).toBe(10)
  })

  it('returns fallback for negative numbers', () => {
    expect(normalizePositiveLimit(-1, 10)).toBe(10)
    expect(normalizePositiveLimit(-100, 10)).toBe(10)
  })

  it('returns at least 1 when value is positive (Math.max(1, ...))', () => {
    // 0.1 is >0 and isFinite, so it passes the first check.
    // Math.max(1, Math.floor(0.1)) = Math.max(1, 0) = 1
    expect(normalizePositiveLimit(0.1, 5)).toBe(1)
    // 1.5 passes the >0 check, floors to 1
    expect(normalizePositiveLimit(1.5, 5)).toBe(1)
    // A value >1 that floors to 1 (edge case)
    expect(normalizePositiveLimit(1.01, 5)).toBe(1)
    // Normal case
    expect(normalizePositiveLimit(2.9, 5)).toBe(2)
  })
})
