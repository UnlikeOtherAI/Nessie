import type { FastifyInstance } from 'fastify'
import type { KnowledgeRouteDeps } from './knowledge-base-access.js'

// Opt-in bounded search.summary (cited synthesis over top hybrid chunks).
// Stub registered ahead of implementation (parallel work lands the handler).
export const registerKnowledgeSummaryRoutes = (
  _app: FastifyInstance,
  _deps: KnowledgeRouteDeps,
): void => {}
