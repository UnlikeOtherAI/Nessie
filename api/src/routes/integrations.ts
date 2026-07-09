import type { FastifyInstance } from 'fastify'

import { registerIntegrationHandoffRoutes } from './integrations/handoffs.js'
import { registerIntegrationProductRoutes } from './integrations/products.js'
import type { RouteDeps } from './types.js'

export const registerIntegrationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  registerIntegrationProductRoutes(app, deps)
  registerIntegrationHandoffRoutes(app, deps)
}
