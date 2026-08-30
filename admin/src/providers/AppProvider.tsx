import { RouterProvider } from 'react-router-dom'
import { router } from '../router'
import { ApiClientProvider } from './ApiClientProvider'
import { AuthSessionProvider } from './AuthSessionProvider'
import { ExternalAuthProvider } from './ExternalAuthProvider'
import { FontScaleProvider } from './FontScaleProvider'
import { FocusModeProvider } from './FocusModeProvider'
import { QueryProvider } from './QueryProvider'
import { ThemeProvider } from './ThemeProvider'

export const AppProvider = () => (
  <QueryProvider>
    <AuthSessionProvider>
      <ExternalAuthProvider>
        <ApiClientProvider>
          <ThemeProvider>
            <FontScaleProvider>
              <FocusModeProvider>
                <RouterProvider router={router} />
              </FocusModeProvider>
            </FontScaleProvider>
          </ThemeProvider>
        </ApiClientProvider>
      </ExternalAuthProvider>
    </AuthSessionProvider>
  </QueryProvider>
)
