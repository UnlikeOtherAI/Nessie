import {
  Navigate,
  createBrowserRouter,
  useLocation,
} from 'react-router-dom'
import { resolveRootLandingPath } from './facades/billing/checkout-return'
import { readNativePendingPushPath } from './lib/mobile-shell'
import { AdminShellLayout } from './layouts/AdminShellLayout'
import { RootLayout } from './layouts/RootLayout'
import { SearchPage } from './pages/SearchPage'
import { AgentActivityPage } from './pages/AgentActivityPage'
import { AlertsPage } from './pages/AlertsPage'
import { AgentDesignerPage } from './pages/AgentDesignerPage'
import { AgentsPage } from './pages/AgentsPage'
import { ExecutorsPage } from './pages/ExecutorsPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { AuditLogPage } from './pages/AuditLogPage'
import { BootstrapPage } from './pages/BootstrapPage'
import { ChannelProjectOverviewPage } from './pages/channels/ChannelProjectOverviewPage'
import { ChannelConversationComposePage } from './pages/ChannelConversationComposePage'
import { ChannelsPage } from './pages/ChannelsPage'
import { FeedbackPage } from './pages/FeedbackPage'
import { ProductPageHost } from './components/features/integrations/ProductPageHost'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { KnowledgeBasePage } from './pages/KnowledgeBasePage'
import { LoginPage } from './pages/LoginPage'
import { McpAppStorePage } from './pages/McpAppStorePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { OperationalTelemetryPage } from './pages/OperationalTelemetryPage'
import { OpsHealthPage } from './pages/OpsHealthPage'
import { PolicyPage } from './pages/PolicyPage'
import { ProjectsIndexPage } from './pages/ProjectsIndexPage'
import { ProjectView } from './pages/project/ProjectView'
import { AppearancePage } from './pages/settings/AppearancePage'
import { ConnectionsPage } from './pages/settings/ConnectionsPage'
import { NotificationsPage } from './pages/settings/NotificationsPage'
import { OrganizationSettingsPage } from './pages/settings/OrganizationSettingsPage'
import { PushCredentialsPage } from './pages/settings/PushCredentialsPage'
import { SecuritySettingsPage } from './pages/settings/SecuritySettingsPage'
import { SettingsChannelsPage } from './pages/settings/SettingsChannelsPage'
import { SettingsMembersPage } from './pages/settings/SettingsMembersPage'
import { SettingsProfilePage } from './pages/settings/SettingsProfilePage'
import { StatusesPage } from './pages/settings/StatusesPage'
import { ToolsPage } from './pages/ToolsPage'
import { TokenUsagePage } from './pages/TokenUsagePage'
import { TriggersPage } from './pages/TriggersPage'
import { WorkflowDesignerPage } from './pages/WorkflowDesignerPage'
import { WorkflowsPage } from './pages/WorkflowsPage'

const RootRouteRedirect = () => {
  const { search } = useLocation()
  // The native shell injects a tapped notification route before this SPA
  // starts. Resolve it here, rather than first redirecting to /channels and
  // replacing the notification destination with the default conversation.
  return <Navigate to={resolveRootLandingPath(search, readNativePendingPushPath())} replace />
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
  {
    path: '/',
    element: <RootRouteRedirect />,
  },
  {
    path: '/bootstrap',
    element: <BootstrapPage />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/workflows',
    element: <Navigate to="/agents/workflows" replace />,
  },
  {
    path: '/threads',
    element: <Navigate to="/channels" replace />,
  },
  {
    path: '/chats',
    element: <Navigate to="/channels" replace />,
  },
  {
    // Tool management consolidated onto the canonical /agents/tools registry;
    // these redirects keep old bookmarks and the mobile WebView shell working.
    path: '/workflows/tools',
    element: <Navigate to="/agents/tools" replace />,
  },
  {
    path: '/settings/tools',
    element: <Navigate to="/agents/tools" replace />,
  },
  {
    // /settings/agents folded into the Agents browser (/agents) + designer.
    path: '/settings/agents',
    element: <Navigate to="/agents" replace />,
  },
  {
    path: '/integrations',
    element: <Navigate to="/settings/integrations" replace />,
  },
  {
    element: <AdminShellLayout />,
    children: [
      {
        path: '/channels/new',
        element: <ChannelConversationComposePage />,
      },
      {
        path: '/channels/projects/:projectId',
        element: <ChannelProjectOverviewPage />,
      },
      {
        // Reply-thread panel (#233): deep-linkable third pane; Back closes it.
        path: '/channels/:channelId/threads/:threadId/replies/:rootMessageId',
        element: <ChannelsPage />,
      },
      {
        path: '/channels/:channelId?',
        element: <ChannelsPage />,
      },
      {
        path: '/projects',
        element: <ProjectsIndexPage />,
      },
      {
        path: '/projects/:projectId',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/board',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/backlog',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/insights',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/docs',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/executors',
        element: <ProjectView />,
      },
      {
        path: '/projects/:projectId/settings',
        element: <ProjectView />,
      },
      {
        // Product `nav_page` surfaces (e.g. DeepSignal's /signals) mount on the
        // generic registry-driven host. The host gates on live activation and
        // renders the concrete page once a slice registers it in
        // product-page-registry; adding a new product route means adding its
        // manifest-declared path here.
        path: '/signals',
        element: <ProductPageHost />,
      },
      {
        path: '/agents',
        element: <AgentsPage />,
      },
      {
        // /work folded into the project Kanban menu; redirect kept for the
        // shipped mobile WebView shell, which may deep-link the old path.
        path: '/work',
        element: <Navigate to="/projects" replace />,
      },
      {
        path: '/knowledge-base',
        element: <KnowledgeBasePage />,
      },
      {
        path: '/agents/activity',
        element: <AgentActivityPage />,
      },
      {
        path: '/agents/designer',
        element: <AgentDesignerPage />,
      },
      {
        path: '/agents/designer/:agentId',
        element: <AgentDesignerPage />,
      },
      {
        path: '/agents/workflow-designer',
        element: <WorkflowDesignerPage />,
      },
      {
        path: '/agents/workflow-designer/:workflowTemplateId',
        element: <WorkflowDesignerPage />,
      },
      {
        path: '/agents/triggers',
        element: <TriggersPage />,
      },
      {
        path: '/agents/workflows',
        element: <WorkflowsPage />,
      },
      {
        path: '/agents/tools',
        element: <ToolsPage />,
      },
      {
        path: '/agents/executors',
        element: <ExecutorsPage />,
      },
      {
        path: '/mcp-app-store',
        element: <McpAppStorePage />,
      },
      {
        path: '/settings',
        element: <Navigate to="/settings/profile" replace />,
      },
      {
        path: '/settings/profile',
        element: <SettingsProfilePage />,
      },
      {
        path: '/settings/security',
        element: <SecuritySettingsPage />,
      },
      {
        path: '/settings/organization',
        element: <OrganizationSettingsPage />,
      },
      {
        path: '/settings/statuses',
        element: <StatusesPage />,
      },
      {
        path: '/settings/statuses/:statusId',
        element: <StatusesPage />,
      },
      {
        path: '/settings/notifications',
        element: <NotificationsPage />,
      },
      {
        path: '/settings/connections',
        element: <ConnectionsPage />,
      },
      {
        path: '/settings/integrations',
        element: <IntegrationsPage />,
      },
      {
        path: '/settings/appearance',
        element: <AppearancePage />,
      },
      {
        path: '/settings/members',
        element: <SettingsMembersPage />,
      },
      {
        path: '/settings/channels',
        element: <SettingsChannelsPage />,
      },
      {
        path: '/settings/push',
        element: <PushCredentialsPage />,
      },
      {
        path: '/audit',
        element: <AuditLogPage />,
      },
      {
        path: '/approvals',
        element: <ApprovalsPage />,
      },
      {
        path: '/alerts',
        element: <AlertsPage />,
      },
      {
        path: '/tokens',
        element: <TokenUsagePage />,
      },
      {
        path: '/policy',
        element: <PolicyPage />,
      },
      {
        path: '/ops',
        element: <OpsHealthPage />,
      },
      {
        path: '/ops/usage',
        element: <OperationalTelemetryPage />,
      },
      {
        path: '/search',
        element: <SearchPage />,
      },
      {
        path: '/feedback',
        element: <FeedbackPage />,
      },
    ],
  },
  {
    path: '*',
    element: <NotFoundPage />,
  },
    ],
  },
])
