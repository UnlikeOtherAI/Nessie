import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AdminShellLayout } from './layouts/AdminShellLayout'
import { BootstrapPage } from './pages/BootstrapPage'
import { ChannelsPage } from './pages/ChannelsPage'
import { LoginPage } from './pages/LoginPage'
import { SettingsPage } from './pages/SettingsPage'

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
        path: '/settings',
        element: <SettingsPage />,
      },
    ],
  },
])
