import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useColorScheme } from 'react-native'

import type { MeResponse } from '@nessie/schemas'

import { useAuth } from './auth-context'
import {
  PALETTES,
  resolvePaletteMode,
  type ThemePalette,
  type ThemePaletteMode,
} from './theme'

type ThemeContextValue = {
  mode: ThemePaletteMode
  theme: ThemePalette
}

type PreferencesWithTheme = {
  theme?: unknown
}

type MeWithRootPreferences = MeResponse & {
  preferences?: PreferencesWithTheme
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const getStringTheme = (preferences: PreferencesWithTheme | undefined): string | undefined => {
  const theme = preferences?.theme
  return typeof theme === 'string' ? theme : undefined
}

const getThemePreference = (me: MeResponse | null): string | undefined => {
  if (!me) {
    return undefined
  }

  const userPreference = getStringTheme(me.user.preferences as PreferencesWithTheme | undefined)
  return userPreference ?? getStringTheme((me as MeWithRootPreferences).preferences)
}

export const ThemeProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const systemScheme = useColorScheme()
  const { me } = useAuth()
  const preference = getThemePreference(me)
  const mode = resolvePaletteMode({ preference, systemScheme })
  const theme = PALETTES[mode]
  const value = useMemo<ThemeContextValue>(() => ({ mode, theme }), [mode, theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useThemeContext = (): ThemeContextValue => {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('useThemeContext must be used within <ThemeProvider>')
  }
  return value
}

export const useTheme = (): ThemePalette => useThemeContext().theme
