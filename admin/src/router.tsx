import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AdminShellLayout } from './layouts/AdminShellLayout'
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
        path: '/triggers',
        element: <TriggersPage />,
      },
      {
        path: '/agents/new',
        element: <AgentDesignerPage />,
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
