export class KnowledgeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeConflictError'
  }
}

export const isKnowledgeConflictError = (
  error: unknown,
): error is KnowledgeConflictError => error instanceof KnowledgeConflictError

export type KnowledgeAnnotationErrorCode = 'not_found' | 'forbidden' | 'invalid'

// Raised by the annotations service so callers (API routes, worker tools) can map
// a single failure mode to the right transport response without leaking Prisma.
export class KnowledgeAnnotationError extends Error {
  readonly code: KnowledgeAnnotationErrorCode

  constructor(code: KnowledgeAnnotationErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeAnnotationError'
    this.code = code
  }
}

export const isKnowledgeAnnotationError = (
  error: unknown,
): error is KnowledgeAnnotationError => error instanceof KnowledgeAnnotationError
