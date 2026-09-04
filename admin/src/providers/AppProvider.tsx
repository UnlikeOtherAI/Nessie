import { RouterProvider } from 'react-router-dom'
import { DesktopWindowFrame } from '../components/desktop/DesktopWindowFrame'
import { router } from '../router'
import { ApiClientProvider } from './ApiClientProvider'
import { AuthSessionProvider } from './AuthSessionProvider'
import { ExternalAuthProvider } from './ExternalAuthProvider'
import { FontScaleProvider } from './FontScaleProvider'
import { FocusModeProvider } from './FocusModeProvider'
import { QueryProvider } from './QueryProvider'
import { ShellEnvironmentProvider } from './ShellEnvironmentProvider'
import { ThemeProvider } from './ThemeProvider'

// DesktopWindowFrame wraps the router rather than a layout: on the frameless
// Windows and Linux shells the window controls and the resize border have to
// exist on the sign-in screen too, and every route the shell can land on. It
// renders `children` untouched on macOS and on the web.
export const AppProvider = () => (
  <ShellEnvironmentProvider>
    <QueryProvider>
      <AuthSessionProvider>
        <ExternalAuthProvider>
          <ApiClientProvider>
            <ThemeProvider>
              <FontScaleProvider>
                <FocusModeProvider>
                  <DesktopWindowFrame>
                    <RouterProvider router={router} />
                  </DesktopWindowFrame>
                </FocusModeProvider>
              </FontScaleProvider>
            </ThemeProvider>
          </ApiClientProvider>
        </ExternalAuthProvider>
      </AuthSessionProvider>
    </QueryProvider>
  </ShellEnvironmentProvider>
)
