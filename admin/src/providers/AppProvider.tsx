import { RouterProvider } from 'react-router-dom'
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
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryProvider>
    </ApiClientProvider>
  </AuthSessionProvider>
)
