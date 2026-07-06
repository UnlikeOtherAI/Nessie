import type { FastifyInstance } from 'fastify'
import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

// Ticket-bound documents + personal-space provisioning. Stub registered ahead
// of implementation (parallel work lands the handlers).
export const registerKnowledgeTaskRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {}
