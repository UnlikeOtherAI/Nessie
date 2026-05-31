export const HYBRID_FUSION_CONFIG = {
  recencyDecayPerDay: 0.01,
  recencyWeight: 0.01,
  reciprocalRankK: 60,
} as const

const DAY_MS = 24 * 60 * 60 * 1000

export type RetrievalCandidateBase = {
  id: string
  createdAt: Date | string
  lastAccessedAt?: Date | string | null
}

export type RankedRetrievalCandidate<T extends RetrievalCandidateBase> = {
  candidate: T
  rank: number
}

export type FusedRetrievalResult<T extends RetrievalCandidateBase> = {
  candidate: T
  lexicalRank: number | null
  recencyScore: number
  rrfScore: number
  semanticRank: number | null
  similarity: number
}

export type FuseHybridCandidatesInput<T extends RetrievalCandidateBase> = {
  lexicalCandidates?: RankedRetrievalCandidate<T>[]
  limit?: number
  now?: Date | string
  semanticCandidates?: RankedRetrievalCandidate<T>[]
}

type CandidatePair<T extends RetrievalCandidateBase> = {
  lexical?: RankedRetrievalCandidate<T>
  semantic?: RankedRetrievalCandidate<T>
}

const toTimestamp = (value: Date | string): number => {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (Number.isNaN(time)) {
    throw new Error(`Invalid retrieval timestamp: ${String(value)}`)
  }
  return time
}

export const reciprocalRankScore = (
  rank: number | null | undefined,
): number => rank === null || rank === undefined
  ? 0
  : 1.0 / (HYBRID_FUSION_CONFIG.reciprocalRankK + rank)

export const calculateRecencyScore = (
  input: Pick<RetrievalCandidateBase, 'createdAt' | 'lastAccessedAt'>,
  now: Date | string = new Date(),
): number => {
  const basis = input.lastAccessedAt ?? input.createdAt
  const ageDays = (toTimestamp(now) - toTimestamp(basis)) / DAY_MS

  return 1.0 / (
    1.0 + (ageDays * HYBRID_FUSION_CONFIG.recencyDecayPerDay)
  )
}

export const fuseHybridCandidates = <T extends RetrievalCandidateBase>(
  input: FuseHybridCandidatesInput<T>,
): FusedRetrievalResult<T>[] => {
  const pairs = new Map<string, CandidatePair<T>>()

  for (const semantic of input.semanticCandidates ?? []) {
    pairs.set(semantic.candidate.id, {
      ...pairs.get(semantic.candidate.id),
      semantic,
    })
  }

  for (const lexical of input.lexicalCandidates ?? []) {
    pairs.set(lexical.candidate.id, {
      ...pairs.get(lexical.candidate.id),
      lexical,
    })
  }

  const fused = [...pairs.values()].map((pair) => {
    const candidate = pair.semantic?.candidate ?? pair.lexical?.candidate
    if (!candidate) {
      throw new Error('Cannot fuse an empty retrieval candidate pair')
    }

    const recencyScore = calculateRecencyScore(
      {
        createdAt: candidate.createdAt,
        lastAccessedAt:
          pair.semantic?.candidate.lastAccessedAt
          ?? pair.lexical?.candidate.lastAccessedAt
          ?? candidate.createdAt,
      },
      input.now,
    )
    const semanticRank = pair.semantic?.rank ?? null
    const lexicalRank = pair.lexical?.rank ?? null
    const rrfScore = reciprocalRankScore(semanticRank)
      + reciprocalRankScore(lexicalRank)

    return {
      candidate,
      lexicalRank,
      recencyScore,
      rrfScore,
      semanticRank,
      similarity: rrfScore + (recencyScore * HYBRID_FUSION_CONFIG.recencyWeight),
    }
  })

  fused.sort((left, right) => {
    const scoreDiff = right.similarity - left.similarity
    if (scoreDiff !== 0) {
      return scoreDiff
    }

    return toTimestamp(right.candidate.createdAt)
      - toTimestamp(left.candidate.createdAt)
  })

  return input.limit === undefined ? fused : fused.slice(0, input.limit)
}
