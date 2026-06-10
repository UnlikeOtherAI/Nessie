import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'

const STORAGE_KEY = 'nessie.theme'

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
    description: 'The current purple-on-dark Nessie palette.',
    id: 'nebula',
    label: 'Nebula',
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
    description: 'Warm sand surfaces with terracotta controls.',
    id: 'sandstone',
    label: 'Sandstone',
  },
] as const satisfies readonly ThemeOption[]

const THEME_IDS = new Set<Theme>(THEMES.map((theme) => theme.id))

const ThemeContext = createContext<ThemeContextValue | null>(null)

const isTheme = (value: string | null): value is Theme =>
  value !== null && THEME_IDS.has(value as Theme)

const getStoredTheme = (): Theme => {
  if (typeof window === 'undefined') {
    return 'nebula'
  }

  try {
    const storedTheme = window.localStorage.getItem(STORAGE_KEY)
    return isTheme(storedTheme) ? storedTheme : 'nebula'
  } catch {
    return 'nebula'
  }
}

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    document.documentElement.dataset.theme = theme

    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Storage can be unavailable in private or constrained browser contexts.
    }
  }, [theme])

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme)
  }, [])

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
      <div className="min-h-screen text-[var(--ink)]">{children}</div>
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
