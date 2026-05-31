import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateRecencyScore,
  fuseHybridCandidates,
  HYBRID_FUSION_CONFIG,
  reciprocalRankScore,
  type RetrievalCandidateBase,
} from '../src/index.js'

const closeTo = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 0.000000000001,
    `${actual} should be close to ${expected}`,
  )
}

test('fusion constants match the SQL hybrid retrieval formula', () => {
  assert.deepEqual(HYBRID_FUSION_CONFIG, {
    recencyDecayPerDay: 0.01,
    recencyWeight: 0.01,
    reciprocalRankK: 60,
  })
})

test('reciprocal rank and recency scoring match match_thoughts_hybrid', () => {
  closeTo(reciprocalRankScore(1), 1 / 61)
  closeTo(reciprocalRankScore(3), 1 / 63)
  closeTo(
    calculateRecencyScore(
      {
        createdAt: '2026-04-08T00:00:00.000Z',
        lastAccessedAt: '2026-04-09T00:00:00.000Z',
      },
      '2026-04-10T00:00:00.000Z',
    ),
    1 / (1 + (1 * 0.01)),
  )
})

test('hybrid fusion orders by RRF plus weighted recency, then created_at desc', () => {
  const candidates: Record<string, RetrievalCandidateBase> = {
    a: {
      createdAt: '2026-04-08T00:00:00.000Z',
      id: 'a',
      lastAccessedAt: '2026-04-09T00:00:00.000Z',
    },
    b: {
      createdAt: '2026-04-10T00:00:00.000Z',
      id: 'b',
      lastAccessedAt: null,
    },
    c: {
      createdAt: '2026-03-11T00:00:00.000Z',
      id: 'c',
      lastAccessedAt: null,
    },
  }

  const fused = fuseHybridCandidates({
    lexicalCandidates: [
      { candidate: candidates.a, rank: 3 },
      { candidate: candidates.c, rank: 1 },
    ],
    now: '2026-04-10T00:00:00.000Z',
    semanticCandidates: [
      { candidate: candidates.a, rank: 1 },
      { candidate: candidates.b, rank: 2 },
    ],
  })

  assert.deepEqual(
    fused.map((result) => result.candidate.id),
    ['a', 'b', 'c'],
  )
  closeTo(
    fused[0]?.similarity ?? 0,
    (1 / 61) + (1 / 63) + ((1 / 1.01) * 0.01),
  )
  closeTo(
    fused[1]?.similarity ?? 0,
    (1 / 62) + (1 * 0.01),
  )
  closeTo(
    fused[2]?.similarity ?? 0,
    (1 / 61) + ((1 / 1.3) * 0.01),
  )
})

test('hybrid fusion uses created_at descending as the stable SQL tie-breaker', () => {
  const fused = fuseHybridCandidates({
    now: '2026-04-10T00:00:00.000Z',
    semanticCandidates: [
      {
        candidate: { createdAt: '2026-04-09T00:00:00.000Z', id: 'older' },
        rank: 1,
      },
      {
        candidate: { createdAt: '2026-04-10T00:00:00.000Z', id: 'newer' },
        rank: 1,
      },
    ],
  })

  assert.deepEqual(
    fused.map((result) => result.candidate.id),
    ['newer', 'older'],
  )
})
