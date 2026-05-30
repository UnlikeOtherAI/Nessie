import type { FastifyInstance } from 'fastify'

import { registerWorkflowInstallationRoutes } from './workflows/installations.js'
import { registerWorkflowRunRoutes } from './workflows/runs.js'
import { registerWorkflowTemplateRoutes } from './workflows/templates.js'
import type { RouteDeps } from './types.js'

/**
 * Workflow HTTP surface. The handlers are split across `./workflows/{templates,
 * installations,runs}.ts` to keep every file under the 500-line cap (AGENTS.md);
 * this thin shim preserves the original registration order so Fastify route
 * ordering is unchanged: templates → installations → runs/step-runs.
 */
export const registerWorkflowRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  registerWorkflowTemplateRoutes(app, deps)
  registerWorkflowInstallationRoutes(app, deps)
  registerWorkflowRunRoutes(app, deps)
}
