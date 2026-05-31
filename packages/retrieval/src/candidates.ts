import type { Queryable } from './query.js'

export interface CandidateGenerator<QueryInput, Candidate> {
  search(input: QueryInput, db: Queryable): Promise<Candidate[]>
}
