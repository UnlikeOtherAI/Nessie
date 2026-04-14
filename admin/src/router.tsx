import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AdminShellLayout } from './layouts/AdminShellLayout'
import { AgentActivityPage } from './pages/AgentActivityPage'
import { AgentDesignerPage } from './pages/AgentDesignerPage'
import { AgentsPage } from './pages/AgentsPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { AuditLogPage } from './pages/AuditLogPage'
import { BootstrapPage } from './pages/BootstrapPage'
import { ChannelsPage } from './pages/ChannelsPage'
import { LoginPage } from './pages/LoginPage'
import { PolicyPage } from './pages/PolicyPage'
import { SettingsPage } from './pages/SettingsPage'
import { TokenUsagePage } from './pages/TokenUsagePage'
import { TriggersPage } from './pages/TriggersPage'
import { WorkflowDesignerPage } from './pages/WorkflowDesignerPage'
import { WorkflowsPage } from './pages/WorkflowsPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/channels" replace />,
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
    element: <AdminShellLayout />,
    children: [
      {
        path: '/channels/:channelId?',
        element: <ChannelsPage />,
      },
      {
        path: '/agents',
        element: <AgentsPage />,
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
        path: '/settings',
        element: <SettingsPage />,
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
        path: '/tokens',
        element: <TokenUsagePage />,
      },
      {
        path: '/policy',
        element: <PolicyPage />,
      },
    ],
  },
])
