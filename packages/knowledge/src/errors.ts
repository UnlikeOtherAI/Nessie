export class KnowledgeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeConflictError'
  }
}

export const isKnowledgeConflictError = (
  error: unknown,
): error is KnowledgeConflictError => error instanceof KnowledgeConflictError
