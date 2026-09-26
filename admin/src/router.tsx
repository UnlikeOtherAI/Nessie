import { Suspense, type ComponentType, type ReactElement } from 'react'
import { createBrowserRouter, useLocation } from 'react-router-dom'
import { resolveRootLandingPath } from './facades/billing/checkout-return'
import { consumeDesktopPendingPath } from './lib/desktop'
import { readNativePendingPushPath } from './lib/native-shell'
import { usePhoneLayout } from './navigation/mobile-shell'
import { AdminShellLayout } from './layouts/AdminShellLayout'
import { RootLayout } from './layouts/RootLayout'
import { RedirectRoute } from './navigation/RedirectRoute'
import { Skeleton, type SkeletonVariant } from './components/primitives/Skeleton'
import { BootstrapPage } from './pages/BootstrapPage'
import { ChannelsPage } from './pages/ChannelsPage'
import { ExternalAuthCompletionPage } from './pages/ExternalAuthCompletionPage'
import { LoginRoute } from './pages/LoginRoute'
import { NotFoundPage } from './pages/NotFoundPage'
import {
  AgentDesignerPage,
  AgentDetailPage,
  AgentMailboxPage,
  AgentsPage,
  AlertsPage,
  AppDetailPage,
  AppearancePage,
  AppsPage,
  AutomationsPage,
  BillingPage,
  BoardSettingsPage,
  ChannelConversationComposePage,
  ChannelProjectOverviewPage,
  CompanyConnectionsPage,
  ComputersPage,
  ConnectedMailPage,
  ConnectionDetailPage,
  ConnectionsPage,
  DocumentWindowPage,
  ExecutorDetailPage,
  ExecutorSessionPage,
  ExecutorSessionsPage,
  FeedbackPage,
  KeysPage,
  KnowledgeBasePage,
  ModelsPage,
  NotificationsPage,
  OperationalTelemetryPage,
  OpsHealthPage,
  OrganizationPage,
  OrganizationPairedAgentDetailPage,
  OrganizationSecurityPage,
  PairedAgentDetailPage,
  PeoplePage,
  PersonalUsagePage,
  PolicyPage,
  ProjectBoardsPage,
  ProjectDashboardPage,
  ProjectDirectoryPage,
  ProjectView,
  ProjectsIndexPage,
  PushCredentialsPage,
  SearchPage,
  SecretsPage,
  SecurityPage,
  SessionDebugPage,
  SettingsProfilePage,
  StatusDetailPage,
  StatusesPage,
  TaskSetCreatePage,
  TaskSetDetailPage,
  TeamPage,
  TeamsPage,
  ThreadsPage,
  ToolDetailPage,
  ToolsPage,
  TriggerDetailPage,
  UnreadMessagesPage,
  WorkflowDesignerPage,
  YourComputersPage,
} from './router-lazy-pages'

// Every route below is imported eagerly except the seven eager names above:
// the shell/layout roots, the auth gate (`LoginRoute`, `BootstrapPage`,
// `ExternalAuthCompletionPage`), the catch-all, and `ChannelsPage` — the
// first screen almost every session lands on. Everything else is behind
// `React.lazy` in `router-lazy-pages.ts`, so the entry chunk stops shipping
// the workflow designer, the agent designer, every settings tab and every
// governance page before a reader ever opens a channel
// (docs/plans/2026-09-05-admin-architecture-review/audit/05-pages-routing.md
// F1, audit/09-boundary-errors-tests.md F5). `lazyElement` is the one
// Suspense boundary: it lives here, not in `RootLayout`/`AdminShellLayout`,
// so a suspended screen still lands inside the same container the settle
// (docs/navigation/verification-and-settle.md §12) measures for its `h1`,
// and the fallback is the shared `Skeleton` so a loading chunk reads like a
// loading screen, never a jump in the push/pop motion (§3).
// The fallback is marked so the navigation e2e suite's "settled" wait can
// tell a loading chunk from a landed screen: the layer animation finishes
// before the chunk arrives, and a check that reads the screen at that moment
// would read the Skeleton (e2e/navigation/lib/freeze.mjs).
const routeLoading = (variant: SkeletonVariant): ReactElement => (
  <div data-route-loading="">
    <Skeleton variant={variant} />
  </div>
)

const lazyElement = (Component: ComponentType, variant: SkeletonVariant): ReactElement => (
  <Suspense fallback={routeLoading(variant)}>
    <Component />
  </Suspense>
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

// `/admin` and `/settings` are list roots (docs/navigation/overview.md §1): on
// a phone the section's list is the page, which the shell draws in place of
// this route's element; a wider layout pins that list beside the detail
// column, so the route forwards to the list's first page.
const ContextualListRoute = ({ to }: { to: string }) => {
  const phoneLayout = usePhoneLayout()
  return phoneLayout ? null : <RedirectRoute to={to} />
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
    // A document in a window of its own: the desktop shell's double-tap
    // (lib/document-window.ts) points a new window here, and the route is
    // deliberately *outside* `AdminShellLayout` — a window holding one
    // document has no sidebar, no rail and no tab bar to render.
    path: '/documents/:spaceId/:pageId',
    element: lazyElement(DocumentWindowPage, 'detail'),
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
          {
            // One conversation with the room's agent: a second, isolated
            // thread in the same channel (docs/plans/2026-09-08-agent-conversations.md).
            // Listed after the two panels that hang off a thread, so those keep
            // their more specific rows.
            path: ':channelId/threads/:threadId',
          },
          {
            // An agent tool opened from the conversation info screen. The rail
            // beside a wide conversation keeps its choice in component state;
            // a single-column layout has no rail and pushes a real screen, so
            // Back and a deep link both resolve.
            path: ':channelId/tools/:toolId',
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
        path: '/projects/directory',
        element: lazyElement(ProjectDirectoryPage, 'list'),
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
        path: '/projects/:projectId/boards',
        element: lazyElement(ProjectBoardsPage, 'list'),
      },
      {
        path: '/projects/:projectId/boards/:boardId/settings',
        element: lazyElement(BoardSettingsPage, 'detail'),
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
        path: '/projects/:projectId/dashboards',
        element: lazyElement(ProjectView, 'board'),
      },
      {
        // One dashboard, full screen — its own page rather than a project tab,
        // because it is what the Overview's live tiles open into and it takes
        // the whole surface.
        path: '/projects/:projectId/dashboards/:dashboardId',
        element: lazyElement(ProjectDashboardPage, 'board'),
      },
      {
        path: '/knowledge-base',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/latest',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/shared-with-me',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/agents',
        element: lazyElement(KnowledgeBasePage, 'list'),
      },
      {
        path: '/knowledge-base/agents/:agentId',
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
      { path: '/mail', element: lazyElement(ConnectedMailPage, 'feed') },
      { path: '/mail/:source/:accountId', element: lazyElement(ConnectedMailPage, 'feed') },
      {
        path: '/mail/:source/:accountId/threads/:threadId',
        element: lazyElement(ConnectedMailPage, 'feed'),
      },
      { path: '/mail/:source/:accountId/compose', element: lazyElement(ConnectedMailPage, 'feed') },

      // ── Admin: the rail's section ─────────────────────────────────────────
      { path: '/admin', element: <ContextualListRoute to="/admin/agents" /> },
      // Agents — everyone's first group: agents, apps, computers, automations.
      { path: '/admin/agents', element: lazyElement(AgentsPage, 'list') },
      { path: '/admin/agents/designer', element: lazyElement(AgentDesignerPage, 'detail') },
      { path: '/admin/agents/designer/:agentId', element: lazyElement(AgentDesignerPage, 'detail') },
      { path: '/admin/agents/:agentId', element: lazyElement(AgentDetailPage, 'detail') },
      { path: '/admin/agents/:agentId/mailbox', element: lazyElement(AgentMailboxPage, 'feed') },
      { path: '/admin/apps', element: lazyElement(AppsPage, 'board') },
      { path: '/admin/apps/:slug', element: lazyElement(AppDetailPage, 'detail') },
      { path: '/admin/computers', element: lazyElement(ComputersPage, 'list') },
      { path: '/admin/computers/sessions', element: lazyElement(ExecutorSessionsPage, 'detail') },
      { path: '/admin/computers/:executorId', element: lazyElement(ExecutorDetailPage, 'detail') },
      {
        path: '/admin/computers/:executorId/sessions/:sessionId',
        element: lazyElement(ExecutorSessionPage, 'detail'),
      },
      { path: '/admin/automations', element: lazyElement(AutomationsPage, 'list') },
      {
        path: '/admin/automations/triggers/:triggerId',
        element: lazyElement(TriggerDetailPage, 'detail'),
      },
      {
        path: '/admin/automations/batch-jobs/new',
        element: lazyElement(TaskSetCreatePage, 'detail'),
      },
      {
        path: '/admin/automations/batch-jobs/:taskSetId',
        element: lazyElement(TaskSetDetailPage, 'detail'),
      },
      {
        path: '/admin/automations/workflows/designer',
        element: lazyElement(WorkflowDesignerPage, 'detail'),
      },
      {
        path: '/admin/automations/workflows/designer/:workflowTemplateId',
        element: lazyElement(WorkflowDesignerPage, 'detail'),
      },
      // Organisation — the organisation's administration.
      { path: '/admin/people', element: lazyElement(PeoplePage, 'list') },
      { path: '/admin/teams', element: lazyElement(TeamsPage, 'list') },
      { path: '/admin/teams/:teamId', element: lazyElement(TeamPage, 'detail') },
      { path: '/admin/organisation', element: lazyElement(OrganizationPage, 'detail') },
      { path: '/admin/models', element: lazyElement(ModelsPage, 'list') },
      { path: '/admin/connections', element: lazyElement(CompanyConnectionsPage, 'detail') },
      { path: '/admin/keys', element: lazyElement(KeysPage, 'list') },
      { path: '/admin/usage', element: lazyElement(OperationalTelemetryPage, 'detail') },
      { path: '/admin/billing', element: lazyElement(BillingPage, 'detail') },
      { path: '/admin/security', element: lazyElement(OrganizationSecurityPage, 'list') },
      {
        path: '/admin/security/programs/:credentialId',
        element: lazyElement(OrganizationPairedAgentDetailPage, 'detail'),
      },
      // Advanced — folded shut, for owners and instance operators.
      { path: '/admin/advanced/tools', element: lazyElement(ToolsPage, 'list') },
      { path: '/admin/advanced/tools/:toolId', element: lazyElement(ToolDetailPage, 'detail') },
      { path: '/admin/advanced/access-rules', element: lazyElement(PolicyPage, 'detail') },
      { path: '/admin/advanced/health', element: lazyElement(OpsHealthPage, 'detail') },
      { path: '/admin/advanced/push', element: lazyElement(PushCredentialsPage, 'list') },
      { path: '/admin/advanced/debug', element: lazyElement(SessionDebugPage, 'detail') },

      // ── Your settings: the avatar menu's pages ────────────────────────────
      { path: '/settings', element: <ContextualListRoute to="/settings/profile" /> },
      { path: '/settings/profile', element: lazyElement(SettingsProfilePage, 'detail') },
      { path: '/settings/notifications', element: lazyElement(NotificationsPage, 'detail') },
      { path: '/settings/appearance', element: lazyElement(AppearancePage, 'detail') },
      { path: '/settings/status', element: lazyElement(StatusesPage, 'list') },
      { path: '/settings/status/:statusId', element: lazyElement(StatusDetailPage, 'detail') },
      { path: '/settings/accounts', element: lazyElement(ConnectionsPage, 'list') },
      {
        path: '/settings/accounts/:connectionId',
        element: lazyElement(ConnectionDetailPage, 'detail'),
      },
      { path: '/settings/computers', element: lazyElement(YourComputersPage, 'list') },
      { path: '/settings/keys', element: lazyElement(SecretsPage, 'list') },
      { path: '/settings/usage', element: lazyElement(PersonalUsagePage, 'detail') },
      { path: '/settings/security', element: lazyElement(SecurityPage, 'detail') },
      {
        path: '/settings/security/programs/:credentialId',
        element: lazyElement(PairedAgentDetailPage, 'detail'),
      },

      {
        path: '/alerts',
        element: lazyElement(AlertsPage, 'list'),
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
