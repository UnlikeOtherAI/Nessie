import { lazy } from 'react'

// Every route component the router mounts behind `React.lazy`, kept beside the
// router rather than in it: the table of routes is what a person reads that
// file for, and a hundred and twenty import lines above it is not part of that
// table. The reason they are lazy — and the one Suspense boundary that renders
// them — stay in `router.tsx`.

export const DocumentWindowPage = lazy(() =>
  import('./pages/DocumentWindowPage').then((m) => ({ default: m.DocumentWindowPage })),
)
export const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })))
export const ProjectDirectoryPage = lazy(() =>
  import('./pages/project/ProjectDirectoryPage').then((m) => ({ default: m.ProjectDirectoryPage })),
)
export const AlertsPage = lazy(() => import('./pages/AlertsPage').then((m) => ({ default: m.AlertsPage })))
export const AgentDesignerPage = lazy(() =>
  import('./pages/AgentDesignerPage').then((m) => ({ default: m.AgentDesignerPage })),
)
export const AgentMailboxPage = lazy(() =>
  import('./pages/AgentMailboxPage').then((m) => ({ default: m.AgentMailboxPage })),
)
export const ConnectedMailPage = lazy(() =>
  import('./pages/ConnectedMailPage').then((m) => ({ default: m.ConnectedMailPage })),
)
export const AgentDetailPage = lazy(() =>
  import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })),
)
export const AgentsPage = lazy(() => import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })))
export const ExecutorsPage = lazy(() =>
  import('./pages/ExecutorsPage').then((m) => ({ default: m.ExecutorsPage })),
)
export const ExecutorDetailPage = lazy(() =>
  import('./pages/ExecutorDetailPage').then((m) => ({ default: m.ExecutorDetailPage })),
)
export const AuditLogPage = lazy(() => import('./pages/AuditLogPage').then((m) => ({ default: m.AuditLogPage })))
export const ChannelProjectOverviewPage = lazy(() =>
  import('./pages/channels/ChannelProjectOverviewPage').then((m) => ({
    default: m.ChannelProjectOverviewPage,
  })),
)
export const ChannelConversationComposePage = lazy(() =>
  import('./pages/ChannelConversationComposePage').then((m) => ({
    default: m.ChannelConversationComposePage,
  })),
)
export const ThreadsPage = lazy(() => import('./pages/ThreadsPage').then((m) => ({ default: m.ThreadsPage })))
export const UnreadMessagesPage = lazy(() =>
  import('./pages/UnreadMessagesPage').then((m) => ({ default: m.UnreadMessagesPage })),
)
export const FeedbackPage = lazy(() => import('./pages/FeedbackPage').then((m) => ({ default: m.FeedbackPage })))
export const KnowledgeBasePage = lazy(() =>
  import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })),
)
export const ProjectDashboardPage = lazy(() =>
  import('./pages/project/ProjectDashboardPage').then((m) => ({ default: m.ProjectDashboardPage })),
)
export const AppDetailPage = lazy(() =>
  import('./pages/AppDetailPage').then((m) => ({ default: m.AppDetailPage })),
)
export const AppsPage = lazy(() => import('./pages/AppsPage').then((m) => ({ default: m.AppsPage })))
export const OperationalTelemetryPage = lazy(() =>
  import('./pages/OperationalTelemetryPage').then((m) => ({ default: m.OperationalTelemetryPage })),
)
export const OpsHealthPage = lazy(() =>
  import('./pages/OpsHealthPage').then((m) => ({ default: m.OpsHealthPage })),
)
export const PolicyPage = lazy(() => import('./pages/PolicyPage').then((m) => ({ default: m.PolicyPage })))
export const ProjectsIndexPage = lazy(() =>
  import('./pages/ProjectsIndexPage').then((m) => ({ default: m.ProjectsIndexPage })),
)
export const ProjectView = lazy(() =>
  import('./pages/project/ProjectView').then((m) => ({ default: m.ProjectView })),
)
export const ProjectBoardsPage = lazy(() =>
  import('./pages/project/ProjectBoardsPage').then((m) => ({ default: m.ProjectBoardsPage })),
)
export const BoardSettingsPage = lazy(() =>
  import('./pages/project/BoardSettingsPage').then((m) => ({ default: m.BoardSettingsPage })),
)
export const PairedAgentDetailPage = lazy(() =>
  import('./pages/settings/PairedAgentDetailPage').then((m) => ({ default: m.PairedAgentDetailPage })),
)
export const OrganizationPairedAgentDetailPage = lazy(() =>
  import('./pages/settings/PairedAgentDetailPage').then(
    (m) => ({ default: m.OrganizationPairedAgentDetailPage }),
  ),
)
export const PairedAgentsPage = lazy(() =>
  import('./pages/settings/PairedAgentsPage').then((m) => ({ default: m.PairedAgentsPage })),
)
export const OrganizationModelsPage = lazy(() =>
  import('./pages/settings/OrganizationModelsPage').then(
    (m) => ({ default: m.OrganizationModelsPage }),
  ),
)
export const OrganizationPairedAgentsPage = lazy(() =>
  import('./pages/settings/OrganizationPairedAgentsPage').then(
    (m) => ({ default: m.OrganizationPairedAgentsPage }),
  ),
)
export const ConnectionDetailPage = lazy(() =>
  import('./pages/settings/ConnectionDetailPage').then((m) => ({ default: m.ConnectionDetailPage })),
)
export const ConnectionsPage = lazy(() =>
  import('./pages/settings/ConnectionsPage').then((m) => ({ default: m.ConnectionsPage })),
)
export const OrganizationSettingsPage = lazy(() =>
  import('./pages/settings/OrganizationSettingsPage').then((m) => ({
    default: m.OrganizationSettingsPage,
  })),
)
export const PushCredentialsPage = lazy(() =>
  import('./pages/settings/PushCredentialsPage').then((m) => ({ default: m.PushCredentialsPage })),
)
export const OrganizationSecretsPage = lazy(() =>
  import('./pages/settings/OrganizationSecretsPage').then((m) => ({
    default: m.OrganizationSecretsPage,
  })),
)
export const SecretsPage = lazy(() =>
  import('./pages/settings/SecretsPage').then((m) => ({ default: m.SecretsPage })),
)
export const TeamSecretsPage = lazy(() =>
  import('./pages/settings/TeamSecretsPage').then((m) => ({ default: m.TeamSecretsPage })),
)
export const SettingsMembersPage = lazy(() =>
  import('./pages/settings/SettingsMembersPage').then((m) => ({ default: m.SettingsMembersPage })),
)
export const TeamMembersPage = lazy(() =>
  import('./pages/settings/TeamMembersPage').then((m) => ({ default: m.TeamMembersPage })),
)
export const TeamSettingsPage = lazy(() =>
  import('./pages/settings/TeamSettingsPage').then((m) => ({ default: m.TeamSettingsPage })),
)
export const TeamModelsPage = lazy(() =>
  import('./pages/settings/team/TeamModelsPage').then((m) => ({ default: m.TeamModelsPage })),
)
export const UserSettingsPage = lazy(() =>
  import('./pages/settings/UserSettingsPage').then((m) => ({ default: m.UserSettingsPage })),
)
export const StatusDetailPage = lazy(() =>
  import('./pages/settings/StatusDetailPage').then((m) => ({ default: m.StatusDetailPage })),
)
export const StatusesPage = lazy(() =>
  import('./pages/settings/StatusesPage').then((m) => ({ default: m.StatusesPage })),
)
export const ToolsPage = lazy(() => import('./pages/ToolsPage').then((m) => ({ default: m.ToolsPage })))
export const ToolDetailPage = lazy(() =>
  import('./pages/ToolDetailPage').then((m) => ({ default: m.ToolDetailPage })),
)
export const TokenUsagePage = lazy(() =>
  import('./pages/TokenUsagePage').then((m) => ({ default: m.TokenUsagePage })),
)
export const TriggersPage = lazy(() => import('./pages/TriggersPage').then((m) => ({ default: m.TriggersPage })))
export const TriggerDetailPage = lazy(() =>
  import('./pages/TriggerDetailPage').then((m) => ({ default: m.TriggerDetailPage })),
)
export const WorkflowDesignerPage = lazy(() =>
  import('./pages/WorkflowDesignerPage').then((m) => ({ default: m.WorkflowDesignerPage })),
)
export const WorkflowsPage = lazy(() =>
  import('./pages/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })),
)
export const TaskSetsPage = lazy(() =>
  import('./pages/TaskSetsPage').then((m) => ({ default: m.TaskSetsPage })),
)
export const TaskSetCreatePage = lazy(() =>
  import('./pages/TaskSetCreatePage').then((m) => ({ default: m.TaskSetCreatePage })),
)
export const TaskSetDetailPage = lazy(() =>
  import('./pages/TaskSetDetailPage').then((m) => ({ default: m.TaskSetDetailPage })),
)
