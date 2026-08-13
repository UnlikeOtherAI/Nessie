import { RouterProvider } from 'react-router-dom'
import { router } from '../router'
import { ApiClientProvider } from './ApiClientProvider'
import { AuthSessionProvider } from './AuthSessionProvider'
import { FontScaleProvider } from './FontScaleProvider'
import { QueryProvider } from './QueryProvider'
import { ThemeProvider } from './ThemeProvider'

export const AppProvider = () => (
  <QueryProvider>
    <AuthSessionProvider>
      <ApiClientProvider>
        <ThemeProvider>
          <FontScaleProvider>
            <RouterProvider router={router} />
          </FontScaleProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryProvider>
)
