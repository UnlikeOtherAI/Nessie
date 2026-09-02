import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * `If-Match` for the auto-saving editors (docs/navigation.md → "Drafts").
 *
 * A surface that saves itself every couple of seconds cannot ask "are you sure
 * you want to overwrite?" — so it states which revision it edited, and the
 * server refuses when that is no longer the current one. The client then shows
 * the choice in place (keep mine / take theirs) rather than a blocking dialog.
 *
 * The version token is the row's own monotonic counter — `Dashboard.revision`,
 * `WorkflowTemplate.version`, `KnowledgePage.revision` — quoted or bare, since
 * both spellings reach us from hand-written clients.
 */
export type IfMatchRevision =
  | { kind: 'absent' }
  | { kind: 'revision'; revision: number }
  | { kind: 'malformed' }

export const readIfMatchRevision = (request: FastifyRequest): IfMatchRevision => {
  const raw = request.headers['if-match']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (typeof header !== 'string' || header.trim().length === 0) {
    return { kind: 'absent' }
  }
  const value = header.trim()
  // `If-Match: *` means "any current version", which is what no header means
  // here: the caller has no opinion about which revision they edited.
  if (value === '*') {
    return { kind: 'absent' }
  }
  const unquoted = value.replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
  if (!/^\d+$/.test(unquoted)) {
    return { kind: 'malformed' }
  }
  const revision = Number.parseInt(unquoted, 10)
  return Number.isSafeInteger(revision) ? { kind: 'revision', revision } : { kind: 'malformed' }
}

/**
 * The refusal carries the current revision so the client can offer "take
 * theirs" without a second round trip.
 */
export const sendRevisionConflict = (
  reply: FastifyReply,
  code: string,
  message: string,
  currentRevision: number,
) =>
  reply.code(409).send({
    error: { code, message, details: { currentRevision } },
  })

export const sendMalformedIfMatch = (reply: FastifyReply) =>
  reply.code(400).send({
    error: {
      code: 'INVALID_IF_MATCH',
      message: 'If-Match must be the current revision number, optionally quoted',
      field: 'if-match',
    },
  })
