import { RouterProvider } from 'react-router-dom'
import { DesktopDragRegion } from '../components/DesktopDragRegion'
import { router } from '../router'
import { ApiClientProvider } from './ApiClientProvider'
import { AuthSessionProvider } from './AuthSessionProvider'
import { QueryProvider } from './QueryProvider'
import { ThemeProvider } from './ThemeProvider'

export const AppProvider = () => (
  <AuthSessionProvider>
    <ApiClientProvider>
      <QueryProvider>
        <ThemeProvider>
          <DesktopDragRegion />
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryProvider>
    </ApiClientProvider>
  </AuthSessionProvider>
)
