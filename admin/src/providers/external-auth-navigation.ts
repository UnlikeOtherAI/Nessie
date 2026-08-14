import { createContext, useContext } from 'react'

export type ExternalAuthNavigation = {
  handleWebLocation: (url: string, origin: string) => void
  registerNavigate: (navigate: (path: string) => void) => () => void
}

export const ExternalAuthNavigationContext = createContext<ExternalAuthNavigation | null>(null)

export const useExternalAuthNavigation = (): ExternalAuthNavigation | null =>
  useContext(ExternalAuthNavigationContext)
