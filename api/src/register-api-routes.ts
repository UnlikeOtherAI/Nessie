import type { FastifyInstance } from 'fastify'

import { registerActivityRoutes } from './routes/activity.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerAgentTodoRoutes } from './routes/agent-todos.js'
import { registerAlertRoutes } from './routes/alerts.js'
import { registerAppRoutes } from './routes/apps.js'
import { registerAppConnectionRequestRoutes } from './routes/app-connection-requests.js'
import { registerAppsConnectRoutes } from './routes/apps-connect.js'
import { registerAppsRegistryRoutes } from './routes/apps-registry.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerAuditLogRoutes } from './routes/audit-log.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerBoardRoutes } from './routes/board.js'
import { registerCallRoutes } from './routes/calls.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerCommsConnectionRoutes } from './routes/comms-connections.js'
import { registerCommsWebhookRoutes } from './routes/comms-webhooks.js'
import { registerDashboardRoutes } from './routes/dashboards.js'
import { registerDesignerRoutes } from './routes/designer.js'
import { registerDemonstrationRoutes } from './routes/demonstrations.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerDisclosureGrantRoutes } from './routes/disclosure-grants.js'
import { registerEventRoutes } from './routes/events.js'
import { registerExecutionEnvironmentRoutes } from './routes/execution-environments.js'
import { registerExecutorRoutes } from './routes/executors.js'
import { registerExternalAgentRoutes } from './routes/external-agent.js'
import { registerFavoriteRoutes } from './routes/favorites.js'
import { registerFeedbackRoutes } from './routes/feedback.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerIntegrationRoutes } from './routes/integrations.js'
import { registerIterationRoutes } from './routes/iterations.js'
import { registerKnowledgeBaseRoutes } from './routes/knowledge-base.js'
import { registerKnowledgeBaseFileRoutes } from './routes/knowledge-base-files.js'
import { registerKnowledgeCommentRoutes } from './routes/knowledge-comments.js'
import { registerKnowledgeLibrarianRoutes } from './routes/knowledge-librarian.js'
import { registerKnowledgeLinkRoutes } from './routes/knowledge-links.js'
import { registerKnowledgeRecentPagesRoutes } from './routes/knowledge-recent-pages.js'
import { registerKnowledgeSummaryRoutes } from './routes/knowledge-summary.js'
import { registerKnowledgeTaskRoutes } from './routes/knowledge-tasks.js'
import { registerLedgerRoutes } from './routes/ledger.js'
import { registerMailboxRoutes } from './routes/mailbox.js'
import { registerMeetingLinkRoutes } from './routes/meeting-links.js'
import { registerOrganizationRoutes } from './routes/organizations.js'
import { registerPlanRoutes } from './routes/plans.js'
import { registerPolicyRoutes } from './routes/policy.js'
import { registerPresenceRoutes } from './routes/presence.js'
import { registerProfileAvatarRoutes } from './routes/profile-avatar.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerResourceLockRoutes } from './routes/resource-locks.js'
import { registerRunRoutes } from './routes/runs.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSecretRoutes } from './routes/secrets.js'
import { registerStatusRoutes } from './routes/statuses.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerTeamRoutes } from './routes/teams.js'
import { registerThoughtRoutes } from './routes/thoughts.js'
import { registerThreadRoutes } from './routes/threads.js'
import { registerToolRoutes } from './routes/tools.js'
import { registerTriggerRoutes } from './routes/triggers.js'
import type { RouteDeps } from './routes/types.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerUserRoutes } from './routes/users.js'
import { registerWebPushRoutes } from './routes/web-push.js'
import { registerWellKnownOAuthClientRoutes } from './routes/well-known-oauth-client.js'
import { registerWorkflowRoutes } from './routes/workflows.js'
import { registerWorkspaceAvatarRoutes } from './routes/workspace-avatar.js'
import { registerWorkspaceInvitationAcceptanceRoute } from './routes/workspace-invitations.js'
import { registerWorkspaceMembersRoutes } from './routes/workspace-members.js'
import {
  buildDashboardEgressPolicy,
  createDashboardCredentialStore,
} from './services/dashboard-runtime.js'

export const registerApiRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  registerHealthRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerChannelRoutes(app, deps)
  registerCallRoutes(app, deps)
  registerAgentRoutes(app, deps)
  registerDemonstrationRoutes(app, deps)
  registerAgentTodoRoutes(app, deps)
  registerTriggerRoutes(app, deps)
  registerPlanRoutes(app, deps)
  registerWorkflowRoutes(app, deps)
  registerExecutionEnvironmentRoutes(app, deps)
  registerDisclosureGrantRoutes(app, deps)
  registerExecutorRoutes(app, deps)
  registerMailboxRoutes(app, deps)
  registerMeetingLinkRoutes(app, deps)
  registerResourceLockRoutes(app, deps)
  registerRunRoutes(app, deps)
  registerToolRoutes(app, deps)
  registerUploadRoutes(app, deps)
  registerDeviceRoutes(app, deps)
  registerWebPushRoutes(app, deps)
  registerCommsConnectionRoutes(app, deps)
  registerCommsWebhookRoutes(app, deps)
  registerCapabilityRoutes(app, deps)
  registerUserRoutes(app, deps)
  registerStatusRoutes(app, deps)
  registerPresenceRoutes(app, deps)
  registerFavoriteRoutes(app, deps)
  registerDashboardRoutes(app, {
    ...deps,
    // Nessie's own origins are denied as dashboard sources: the SSRF guard
    // stops private addresses, but a plain HTTPS call to our own REST surface
    // would carry a source credential instead of the viewer's session.
    egressPolicy: buildDashboardEgressPolicy({
      apiPublicUrl: deps.config.api.publicUrl ?? null,
    }),
    credentials: createDashboardCredentialStore(deps.prisma, deps.authSecret ?? ''),
  })
  registerAlertRoutes(app, deps)
  registerOrganizationRoutes(app, deps)
  registerWorkspaceAvatarRoutes(app, deps)
  registerProfileAvatarRoutes(app, deps)
  registerWorkspaceMembersRoutes(app, deps)
  registerWorkspaceInvitationAcceptanceRoute(app, deps)
  registerFeedbackRoutes(app, deps)
  registerAppRoutes(app, deps)
  registerAppConnectionRequestRoutes(app, deps)
  registerAppsRegistryRoutes(app, deps)
  registerAppsConnectRoutes(app, deps)
  registerWellKnownOAuthClientRoutes(app, deps)
  registerIntegrationRoutes(app, deps)
  registerExternalAgentRoutes(app, deps)
  registerProjectRoutes(app, deps)
  registerBoardRoutes(app, deps)
  registerIterationRoutes(app, deps)
  registerTeamRoutes(app, deps)
  registerEventRoutes(app, deps)
  registerThreadRoutes(app, deps)
  registerSearchRoutes(app, deps)
  registerSecretRoutes(app, deps)
  registerActivityRoutes(app, deps)
  registerThoughtRoutes(app, deps)
  registerDesignerRoutes(app, deps)
  registerAuditLogRoutes(app, deps)
  registerPolicyRoutes(app, deps)
  registerApprovalRoutes(app, deps)
  registerKnowledgeBaseRoutes(app, deps)
  registerKnowledgeBaseFileRoutes(app, deps)
  registerKnowledgeCommentRoutes(app, deps)
  registerKnowledgeLibrarianRoutes(app, deps)
  registerKnowledgeLinkRoutes(app, deps)
  registerKnowledgeRecentPagesRoutes(app, deps)
  registerKnowledgeSummaryRoutes(app, deps)
  registerKnowledgeTaskRoutes(app, deps)
  registerTaskRoutes(app, deps)
  registerBillingRoutes(app, deps)
  registerLedgerRoutes(app, deps)
}
