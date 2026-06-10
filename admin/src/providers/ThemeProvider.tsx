import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { useUpdatePreferences } from '../facades/auth/hooks'
import { useAuthSession } from './AuthSessionProvider'

const STORAGE_KEY = 'nessie.theme'
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)'

export type Theme =
  | 'nebula'
  | 'midnight'
  | 'daylight'
  | 'forest'
  | 'ocean'
  | 'sunset'
  | 'rose'
  | 'graphite'
  | 'sandstone'
  | 'contrast'
  | 'system'

type AppliedTheme = Exclude<Theme, 'system'>

type ThemeOption = {
  description: string
  id: Theme
  label: string
}

type ThemeContextValue = {
  setTheme: (theme: Theme) => void
  theme: Theme
  themes: readonly ThemeOption[]
}

const THEMES = [
  {
    description: 'Warm sand surfaces with terracotta controls.',
    id: 'sandstone',
    label: 'Sandstone',
  },
  {
    description: 'Classic purple-on-dark Nessie palette.',
    id: 'nebula',
    label: 'Classic',
  },
  {
    description: 'Neutral slate surfaces with a clear blue accent.',
    id: 'midnight',
    label: 'Midnight',
  },
  {
    description: 'Light surfaces, dark text, and readable blue accents.',
    id: 'daylight',
    label: 'Daylight',
  },
  {
    description: 'Deep green-charcoal surfaces with a calm emerald accent.',
    id: 'forest',
    label: 'Forest',
  },
  {
    description: 'Navy-teal depth with clear cyan controls and links.',
    id: 'ocean',
    label: 'Ocean',
  },
  {
    description: 'Warm dark brown surfaces with a grounded orange accent.',
    id: 'sunset',
    label: 'Sunset',
  },
  {
    description: 'Dark plum surfaces with rose and magenta emphasis.',
    id: 'rose',
    label: 'Rose',
  },
  {
    description: 'Neutral grayscale surfaces with restrained steel accents.',
    id: 'graphite',
    label: 'Graphite',
  },
  {
    description: 'Maximum separation for text, controls, and surfaces.',
    id: 'contrast',
    label: 'High Contrast',
  },
  {
    description: 'Follow your OS light/dark setting.',
    id: 'system',
    label: 'System',
  },
] as const satisfies readonly ThemeOption[]

const THEME_IDS = new Set<Theme>(THEMES.map((theme) => theme.id))

const ThemeContext = createContext<ThemeContextValue | null>(null)

const isTheme = (value: string | null): value is Theme =>
  value !== null && THEME_IDS.has(value as Theme)

const getLocalTheme = (): Theme | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const storedTheme = window.localStorage.getItem(STORAGE_KEY)
    return isTheme(storedTheme) ? storedTheme : null
  } catch {
    return null
  }
}

const writeLocalTheme = (theme: Theme): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
  }
}

const getStoredTheme = (serverTheme?: Theme): Theme =>
  serverTheme ?? getLocalTheme() ?? 'sandstone'

const getSystemTheme = (mediaQuery?: MediaQueryList): AppliedTheme => {
  if (mediaQuery) {
    return mediaQuery.matches ? 'nebula' : 'daylight'
  }

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'daylight'
  }

  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? 'nebula' : 'daylight'
}

const resolveTheme = (theme: Theme): AppliedTheme =>
  theme === 'system' ? getSystemTheme() : theme

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const { me } = useAuthSession()
  const { mutate: updatePreferences } = useUpdatePreferences()
  const serverTheme = me?.user.preferences?.theme
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme(serverTheme))

  useEffect(() => {
    const nextTheme = getStoredTheme(serverTheme)
    setThemeState((currentTheme) => (currentTheme === nextTheme ? currentTheme : nextTheme))
  }, [serverTheme])

  // Transfer a pre-login theme choice (made on the login page, stored locally)
  // to the account the first time the user signs in without a server-side theme.
  const transferredTheme = useRef(false)
  useEffect(() => {
    if (!me || transferredTheme.current || serverTheme !== undefined) {
      return
    }

    const localTheme = getLocalTheme()
    if (localTheme) {
      transferredTheme.current = true
      updatePreferences({ theme: localTheme })
    }
  }, [me, serverTheme, updatePreferences])

  useEffect(() => {
    writeLocalTheme(theme)

    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.dataset.theme = resolveTheme(theme)

    if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY)
    const resolveSystemTheme = () => {
      document.documentElement.dataset.theme = getSystemTheme(mediaQuery)
    }
    mediaQuery.addEventListener('change', resolveSystemTheme)

    return () => {
      mediaQuery.removeEventListener('change', resolveSystemTheme)
    }
  }, [theme])

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme)
    writeLocalTheme(nextTheme)

    if (me) {
      updatePreferences({ theme: nextTheme })
    }
  }, [me, updatePreferences])

  const value = useMemo(
    () => ({
      setTheme,
      theme,
      themes: THEMES,
    }),
    [setTheme, theme],
  )

  return (
    <ThemeContext.Provider value={value}>
      <div className="min-h-screen text-[color:var(--tx)]">{children}</div>
    </ThemeContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeContext)

  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }

  return context
}
