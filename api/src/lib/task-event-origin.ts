import type { FastifyRequest } from 'fastify'
import type { TaskEventOrigin } from '@nessie/schemas'

/**
 * The origin a ticket change made through this request carries, from the
 * credential the global auth hook verified — never from anything the caller
 * sent. It is an allowlist, like `PERSON_MESSAGE_AUTHORSHIP`: only a person's
 * own session token is `session`, and only a `session` event can start or
 * steer an agent's ticket work (docs/standards/ticket-work.md).
 *
 * An agent access credential (the MCP surface) or a voice device credential
 * is a `token` naming that credential; a request the hook did not
 * authenticate at all is `system`, which starts nothing.
 */
export const taskEventOriginFor = (
  request: Pick<FastifyRequest, 'authenticatedWith' | 'agentCredential' | 'voiceCredential'>,
): TaskEventOrigin => {
  if (request.agentCredential) return { kind: 'token', keyId: request.agentCredential.id }
  if (request.voiceCredential) return { kind: 'token', keyId: request.voiceCredential.id }
  if (request.authenticatedWith === 'session') return { kind: 'session' }
  return { kind: 'system' }
}
