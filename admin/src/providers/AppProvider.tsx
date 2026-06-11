import { RouterProvider } from 'react-router-dom'
import { DesktopDragRegion } from '../components/DesktopDragRegion'
import { router } from '../router'
import { ApiClientProvider } from './ApiClientProvider'
import { AuthSessionProvider } from './AuthSessionProvider'
import { FontScaleProvider } from './FontScaleProvider'
import { QueryProvider } from './QueryProvider'
import { ThemeProvider } from './ThemeProvider'

export const AppProvider = () => (
  <AuthSessionProvider>
    <ApiClientProvider>
      <QueryProvider>
        <ThemeProvider>
          <FontScaleProvider>
            <DesktopDragRegion />
            <RouterProvider router={router} />
          </FontScaleProvider>
        </ThemeProvider>
      </QueryProvider>
    </ApiClientProvider>
  </AuthSessionProvider>
)
