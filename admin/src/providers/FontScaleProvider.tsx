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

const STORAGE_KEY = 'nessie.fontScale'

export type FontScale = 'small' | 'medium' | 'large'

type FontScaleOption = {
  description: string
  id: FontScale
  label: string
}

type FontScaleContextValue = {
  fontScale: FontScale
  scales: readonly FontScaleOption[]
  setFontScale: (scale: FontScale) => void
}

const SCALES = [
  { id: 'small', label: 'Small', description: 'Compact text — fit more on screen.' },
  { id: 'medium', label: 'Medium', description: 'The balanced default size.' },
  { id: 'large', label: 'Large', description: 'Larger text for easier reading.' },
] as const satisfies readonly FontScaleOption[]

// Root html font-size per scale. All type is rem-based (Tailwind text-* and
// --font-size-base), so changing this scales every page's typography.
// Mirrored by the pre-paint bootstrap in admin/index.html; change both together.
const ROOT_FONT_SIZE: Record<FontScale, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
}

const SCALE_IDS = new Set<FontScale>(SCALES.map((scale) => scale.id))

const FontScaleContext = createContext<FontScaleContextValue | null>(null)

const isFontScale = (value: string | null): value is FontScale =>
  value !== null && SCALE_IDS.has(value as FontScale)

const getLocalFontScale = (): FontScale | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isFontScale(stored) ? stored : null
  } catch {
    return null
  }
}

const writeLocalFontScale = (scale: FontScale): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, scale)
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
  }
}

const getStoredFontScale = (serverFontScale?: FontScale): FontScale =>
  serverFontScale ?? getLocalFontScale() ?? 'medium'

export const FontScaleProvider = ({ children }: PropsWithChildren) => {
  const { me } = useAuthSession()
  const { mutate: updatePreferences } = useUpdatePreferences()
  const serverFontScale = me?.user.preferences?.fontScale
  const [fontScale, setFontScaleState] = useState<FontScale>(() => getStoredFontScale(serverFontScale))

  useEffect(() => {
    const nextScale = getStoredFontScale(serverFontScale)
    setFontScaleState((current) => (current === nextScale ? current : nextScale))
  }, [serverFontScale])

  // Transfer a pre-login choice to the account on first sign-in (mirrors theme).
  const transferred = useRef(false)
  useEffect(() => {
    if (!me || transferred.current || serverFontScale !== undefined) {
      return
    }

    const localFontScale = getLocalFontScale()
    if (localFontScale) {
      transferred.current = true
      updatePreferences({ fontScale: localFontScale })
    }
  }, [me, serverFontScale, updatePreferences])

  useEffect(() => {
    writeLocalFontScale(fontScale)
    if (typeof document !== 'undefined') {
      document.documentElement.style.fontSize = ROOT_FONT_SIZE[fontScale]
    }
  }, [fontScale])

  const setFontScale = useCallback((nextScale: FontScale) => {
    setFontScaleState(nextScale)
    writeLocalFontScale(nextScale)

    if (me) {
      updatePreferences({ fontScale: nextScale })
    }
  }, [me, updatePreferences])

  const value = useMemo(
    () => ({ fontScale, scales: SCALES, setFontScale }),
    [fontScale, setFontScale],
  )

  return <FontScaleContext.Provider value={value}>{children}</FontScaleContext.Provider>
}

export const useFontScale = () => {
  const context = useContext(FontScaleContext)

  if (!context) {
    throw new Error('useFontScale must be used within FontScaleProvider')
  }

  return context
}
