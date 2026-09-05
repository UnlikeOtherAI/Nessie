import { lazy, Suspense, type ComponentType, type ReactElement } from 'react'
import { createBrowserRouter, useLocation } from 'react-router-dom'
import { resolveRootLandingPath } from './facades/billing/checkout-return'
import { consumeDesktopPendingPath } from './lib/desktop'
import { readNativePendingPushPath, usePhoneLayout } from './lib/mobile-shell'
import { AdminShellLayout } from './layouts/AdminShellLayout'
import { RootLayout } from './layouts/RootLayout'
import { RedirectRoute } from './navigation/RedirectRoute'
import { Skeleton, type SkeletonVariant } from './components/primitives/Skeleton'
import { BootstrapPage } from './pages/BootstrapPage'
import { ChannelsPage } from './pages/ChannelsPage'
import { ExternalAuthCompletionPage } from './pages/ExternalAuthCompletionPage'
import { LoginRoute } from './pages/LoginRoute'
import { NotFoundPage } from './pages/NotFoundPage'

// Every route below is imported eagerly except the seven names above: the
// shell/layout roots, the auth gate (`LoginRoute`, `BootstrapPage`,
// `ExternalAuthCompletionPage`), the catch-all, and `ChannelsPage` — the
// first screen almost every session lands on. Everything else is behind
// `React.lazy`, so the entry chunk stops shipping the workflow designer, the
// agent designer, every settings tab and every governance page before a
// reader ever opens a channel
// (docs/plans/2026-09-05-admin-architecture-review/audit/05-pages-routing.md
// F1, audit/09-boundary-errors-tests.md F5). `lazyElement` is the one
// Suspense boundary: it lives here, not in `RootLayout`/`AdminShellLayout`,
// so a suspended screen still lands inside the same container the settle
// (docs/navigation/verification-and-settle.md §12) measures for its `h1`,
// and the fallback is the shared `Skeleton` so a loading chunk reads like a
// loading screen, never a jump in the push/pop motion (§3).
const lazyElement = (Component: ComponentType, variant: SkeletonVariant): ReactElement => (
  <Suspense fallback={<Skeleton variant={variant} />}>
    <Component />
  </Suspense>
)

const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })))
const AlertsPage = lazy(() => import('./pages/AlertsPage').then((m) => ({ default: m.AlertsPage })))
const AgentDesignerPage = lazy(() =>
  import('./pages/AgentDesignerPage').then((m) => ({ default: m.AgentDesignerPage })),
)
const AgentMailboxPage = lazy(() =>
  import('./pages/AgentMailboxPage').then((m) => ({ default: m.AgentMailboxPage })),
)
const ConnectedMailPage = lazy(() =>
  import('./pages/ConnectedMailPage').then((m) => ({ default: m.ConnectedMailPage })),
)
const AgentDetailPage = lazy(() =>
  import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })),
)
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const ExecutorsPage = lazy(() =>
  import('./pages/ExecutorsPage').then((m) => ({ default: m.ExecutorsPage })),
)
const ApprovalsPage = lazy(() =>
  import('./pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })),
)
const AuditLogPage = lazy(() => import('./pages/AuditLogPage').then((m) => ({ default: m.AuditLogPage })))
const ChannelProjectOverviewPage = lazy(() =>
  import('./pages/channels/ChannelProjectOverviewPage').then((m) => ({
    default: m.ChannelProjectOverviewPage,
  })),
)
const ChannelConversationComposePage = lazy(() =>
  import('./pages/ChannelConversationComposePage').then((m) => ({
    default: m.ChannelConversationComposePage,
  })),
)
const ThreadsPage = lazy(() => import('./pages/ThreadsPage').then((m) => ({ default: m.ThreadsPage })))
const UnreadMessagesPage = lazy(() =>
  import('./pages/UnreadMessagesPage').then((m) => ({ default: m.UnreadMessagesPage })),
)
const FeedbackPage = lazy(() => import('./pages/FeedbackPage').then((m) => ({ default: m.FeedbackPage })))
const IntegrationsPage = lazy(() =>
  import('./pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })),
)
const KnowledgeBasePage = lazy(() =>
  import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })),
)
const DashboardsPage = lazy(() =>
  import('./pages/DashboardsPage').then((m) => ({ default: m.DashboardsPage })),
)
const DashboardDetailPage = lazy(() =>
  import('./pages/DashboardDetailPage').then((m) => ({ default: m.DashboardDetailPage })),
)
const AppDetailPage = lazy(() =>
  import('./pages/AppDetailPage').then((m) => ({ default: m.AppDetailPage })),
)
const AppsPage = lazy(() => import('./pages/AppsPage').then((m) => ({ default: m.AppsPage })))
const OperationalTelemetryPage = lazy(() =>
  import('./pages/OperationalTelemetryPage').then((m) => ({ default: m.OperationalTelemetryPage })),
)
const OpsHealthPage = lazy(() =>
  import('./pages/OpsHealthPage').then((m) => ({ default: m.OpsHealthPage })),
)
const PolicyPage = lazy(() => import('./pages/PolicyPage').then((m) => ({ default: m.PolicyPage })))
const ProjectsIndexPage = lazy(() =>
  import('./pages/ProjectsIndexPage').then((m) => ({ default: m.ProjectsIndexPage })),
)
const ProjectView = lazy(() =>
  import('./pages/project/ProjectView').then((m) => ({ default: m.ProjectView })),
)
const ConnectionsPage = lazy(() =>
  import('./pages/settings/ConnectionsPage').then((m) => ({ default: m.ConnectionsPage })),
)
const OrganizationSettingsPage = lazy(() =>
  import('./pages/settings/OrganizationSettingsPage').then((m) => ({
    default: m.OrganizationSettingsPage,
  })),
)
const PushCredentialsPage = lazy(() =>
  import('./pages/settings/PushCredentialsPage').then((m) => ({ default: m.PushCredentialsPage })),
)
const OrganizationSecretsPage = lazy(() =>
  import('./pages/settings/OrganizationSecretsPage').then((m) => ({
    default: m.OrganizationSecretsPage,
  })),
)
const SecretsPage = lazy(() =>
  import('./pages/settings/SecretsPage').then((m) => ({ default: m.SecretsPage })),
)
const TeamSecretsPage = lazy(() =>
  import('./pages/settings/TeamSecretsPage').then((m) => ({ default: m.TeamSecretsPage })),
)
const SettingsMembersPage = lazy(() =>
  import('./pages/settings/SettingsMembersPage').then((m) => ({ default: m.SettingsMembersPage })),
)
const TeamMembersPage = lazy(() =>
  import('./pages/settings/TeamMembersPage').then((m) => ({ default: m.TeamMembersPage })),
)
const TeamSettingsPage = lazy(() =>
  import('./pages/settings/TeamSettingsPage').then((m) => ({ default: m.TeamSettingsPage })),
)
const UserSettingsPage = lazy(() =>
  import('./pages/settings/UserSettingsPage').then((m) => ({ default: m.UserSettingsPage })),
)
const StatusesPage = lazy(() =>
  import('./pages/settings/StatusesPage').then((m) => ({ default: m.StatusesPage })),
)
const ToolsPage = lazy(() => import('./pages/ToolsPage').then((m) => ({ default: m.ToolsPage })))
const TokenUsagePage = lazy(() =>
  import('./pages/TokenUsagePage').then((m) => ({ default: m.TokenUsagePage })),
)
const TriggersPage = lazy(() => import('./pages/TriggersPage').then((m) => ({ default: m.TriggersPage })))
const WorkflowDesignerPage = lazy(() =>
  import('./pages/WorkflowDesignerPage').then((m) => ({ default: m.WorkflowDesignerPage })),
)
const WorkflowsPage = lazy(() =>
  import('./pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })),
)

const RootRouteRedirect = () => {
  const { search } = useLocation()
  // The native shell injects a tapped notification route before this SPA
  // starts. Resolve it here, rather than first redirecting to /channels and
  // replacing the notification destination with the default conversation.
  return (
    <RedirectRoute
      to={resolveRootLandingPath(search, readNativePendingPushPath() ?? consumeDesktopPendingPath())}
    />
  )
}

// The Admin tab's first phone page is its existing navigation list. Wider
// layouts preserve the established direct route to Profile & Session.
const SettingsRootRoute = () => {
  const phoneLayout = usePhoneLayout()
  return phoneLayout ? null : <RedirectRoute to="/settings/profile" />
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
    element: <LoginRoute />,
  },
  {
    path: '/login/completing',
    element: <ExternalAuthCompletionPage />,
  },
  {
    path: '/workflows',
    element: <RedirectRoute to="/agents/workflows" />,
  },
  {
    path: '/chats',
    element: <RedirectRoute to="/channels" />,
  },
  {
    // Tool management consolidated onto the canonical /agents/tools registry;
    // these redirects keep old bookmarks and the mobile WebView shell working.
    path: '/workflows/tools',
    element: <RedirectRoute to="/agents/tools" />,
  },
  {
    path: '/settings/tools',
    element: <RedirectRoute to="/agents/tools" />,
  },
  {
    // /settings/agents folded into the Agents browser (/agents) + designer.
    path: '/settings/agents',
    element: <RedirectRoute to="/agents" />,
  },
  {
    // Profile, Security, Notifications and Appearance are now tabs of one
    // account settings screen; these keep existing bookmarks working.
    path: '/settings/profile',
    element: <RedirectRoute to="/settings/account?tab=profile" />,
  },
  {
    path: '/settings/security',
    element: <RedirectRoute to="/settings/account?tab=security" />,
  },
  {
    path: '/settings/notifications',
    element: <RedirectRoute to="/settings/account?tab=notifications" />,
  },
  {
    path: '/settings/appearance',
    element: <RedirectRoute to="/settings/account?tab=appearance" />,
  },
  {
    path: '/integrations',
    element: <RedirectRoute to="/settings/integrations" />,
  },
  {
    element: <AdminShellLayout />,
    children: [
      { path: '/threads', element: lazyElement(ThreadsPage, 'list') },
      { path: '/unread-messages', element: lazyElement(UnreadMessagesPage, 'list') },
      {
        path: '/channels/projects/:projectId',
        element: lazyElement(ChannelProjectOverviewPage, 'detail'),
      },
      {
        // The Channels team stays mounted when a new-message sheet opens,
        // so wider layouts retain the source conversation beneath the composer.
        path: '/channels',
        element: <ChannelsPage />,
        children: [
          { index: true },
          {
            path: 'new',
            element: lazyElement(ChannelConversationComposePage, 'list'),
          },
          {
            // Reply-thread panel (#233): deep-linkable third pane; Back closes it.
            path: ':channelId/threads/:threadId/replies/:rootMessageId',
          },
          {
            // A presented dashboard is a sibling workspace panel, never a modal.
            path: ':channelId/threads/:threadId/dashboards/:dashboardId',
          },
          // Conversation information is a route, not a transient popup: phone
          // Back, notification deep links, tablet inspectors, and desktop all
          // resolve the same explicit hierarchy.
          { path: ':channelId/info' },
          { path: ':channelId/info/members' },
          { path: ':channelId/info/members/add' },
          { path: ':channelId' },
        ],
      },
      {
        path: '/projects',
        element: lazyElement(ProjectsIndexPage, 'list'),
      },
      {
        path: '/projects/:projectId',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/board',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/backlog',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/insights',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/docs',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/executors',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/projects/:projectId/settings',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        path: '/dashboards',
        element: lazyElement(DashboardsPage, 'board'),
      },
      {
        path: '/dashboards/:dashboardId',
        element: lazyElement(DashboardDetailPage, 'board'),
      },
      {
        path: '/agents',
        element: lazyElement(AgentsPage, 'list'),
      },
      {
        // /work folded into the project Kanban menu; redirect kept for the
        // shipped mobile WebView shell, which may deep-link the old path.
        path: '/work',
        element: <RedirectRoute to="/projects" />,
      },
      {
        path: '/knowledge-base',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/spaces/:spaceId',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/views/:productView',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/agents/designer',
        element: lazyElement(AgentDesignerPage, 'detail'),
      },
      {
        path: '/agents/designer/:agentId',
        element: lazyElement(AgentDesignerPage, 'detail'),
      },
      {
        path: '/agents/workflow-designer',
        element: lazyElement(WorkflowDesignerPage, 'detail'),
      },
      {
        path: '/agents/workflow-designer/:workflowTemplateId',
        element: lazyElement(WorkflowDesignerPage, 'detail'),
      },
      {
        path: '/agents/triggers',
        element: lazyElement(TriggersPage, 'list'),
      },
      {
        path: '/agents/workflows',
        element: lazyElement(WorkflowsPage, 'list'),
      },
      {
        path: '/agents/tools',
        element: lazyElement(ToolsPage, 'list'),
      },
      {
        path: '/agents/executors',
        element: lazyElement(ExecutorsPage, 'list'),
      },
      {
        path: '/agents/:agentId/mailbox',
        element: lazyElement(AgentMailboxPage, 'feed'),
      },
      { path: '/mail', element: lazyElement(ConnectedMailPage, 'feed') },
      { path: '/mail/:source/:accountId', element: lazyElement(ConnectedMailPage, 'feed') },
      {
        path: '/mail/:source/:accountId/threads/:threadId',
        element: lazyElement(ConnectedMailPage, 'feed'),
      },
      { path: '/mail/:source/:accountId/compose', element: lazyElement(ConnectedMailPage, 'feed') },
      {
        // Dynamic agent id last: static siblings above outrank it in the
        // router's ranking, so `/agents/triggers` etc. still resolve to their
        // own pages while a real agent id lands on the detail page.
        path: '/agents/:agentId',
        element: lazyElement(AgentDetailPage, 'detail'),
      },
      {
        path: '/apps',
        element: lazyElement(AppsPage, 'board'),
      },
      {
        path: '/apps/:slug',
        element: lazyElement(AppDetailPage, 'detail'),
      },
      {
        path: '/settings',
        element: <SettingsRootRoute />,
      },
      {
        path: '/settings/account',
        element: lazyElement(UserSettingsPage, 'detail'),
      },
      {
        path: '/settings/secrets',
        element: lazyElement(SecretsPage, 'list'),
      },
      {
        path: '/settings/organization',
        element: lazyElement(OrganizationSettingsPage, 'detail'),
      },
      {
        path: '/settings/team',
        element: lazyElement(TeamSettingsPage, 'detail'),
      },
      {
        path: '/settings/team/members',
        element: lazyElement(TeamMembersPage, 'list'),
      },
      {
        path: '/settings/team/secrets',
        element: lazyElement(TeamSecretsPage, 'list'),
      },
      {
        path: '/settings/organization/secrets',
        element: lazyElement(OrganizationSecretsPage, 'list'),
      },
      {
        path: '/settings/statuses',
        element: lazyElement(StatusesPage, 'list'),
      },
      {
        path: '/settings/statuses/:statusId',
        element: lazyElement(StatusesPage, 'list'),
      },
      {
        path: '/settings/connections',
        element: lazyElement(ConnectionsPage, 'list'),
      },
      {
        path: '/settings/integrations',
        element: lazyElement(IntegrationsPage, 'board'),
      },
      {
        path: '/settings/members',
        element: lazyElement(SettingsMembersPage, 'list'),
      },
      {
        path: '/settings/push',
        element: lazyElement(PushCredentialsPage, 'list'),
      },
      {
        path: '/audit',
        element: lazyElement(AuditLogPage, 'list'),
      },
      {
        path: '/approvals',
        element: lazyElement(ApprovalsPage, 'list'),
      },
      {
        path: '/alerts',
        element: lazyElement(AlertsPage, 'list'),
      },
      {
        path: '/tokens',
        element: lazyElement(TokenUsagePage, 'detail'),
      },
      {
        path: '/policy',
        element: lazyElement(PolicyPage, 'detail'),
      },
      {
        path: '/ops',
        element: lazyElement(OpsHealthPage, 'detail'),
      },
      {
        path: '/ops/usage',
        element: lazyElement(OperationalTelemetryPage, 'detail'),
      },
      {
        path: '/search',
        element: lazyElement(SearchPage, 'list'),
      },
      {
        path: '/feedback',
        element: lazyElement(FeedbackPage, 'detail'),
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
