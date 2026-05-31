import type { Pool } from 'pg'

export type Queryable = Pick<Pool, 'query'>

export const toVectorLiteral = (embedding: number[] | null): string | null =>
  embedding ? `[${embedding.join(',')}]` : null
