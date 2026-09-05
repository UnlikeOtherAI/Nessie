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
import {
  evaluateOrganizationTheme,
  organizationThemeCss,
  type EvaluatedTheme,
} from '@nessie/schemas'
import { useUpdatePreferences } from '../facades/auth/hooks'
import { useCurrentOrganization } from '../facades/organization/hooks'
import { useAuthSession } from './AuthSessionProvider'
import { DEFAULT_THEME, resolveThemeChoice } from './theme-resolution'
import {
  forgetLegacyTheme,
  ORGANIZATION_THEME_STYLE_ID,
  readThemeChoice,
  writeAppliedTheme,
  writeOrganizationThemeCss,
  writeThemeChoice,
  type Theme,
} from './theme-storage'

const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)'

export type { AppliedTheme } from './theme-resolution'
export type { Theme } from './theme-storage'

/**
 * The theme ids UnlikeOtherAI's hosted sign-in page understands
 * (`SsoThemeSchema`, `api/src/contracts/auth.ts`). `organization` is ours
 * alone: that page has no access to a tenant's palette, and before sign-in
 * there is no tenant to ask.
 */
export type SignInTheme = Exclude<Theme, 'organization' | 'system'>

type ThemeOption = {
  description: string
  id: Theme
  label: string
}

type ThemeContextValue = {
  /** The palette in force, when an organisation theme is applied or previewed. */
  organizationTheme: EvaluatedTheme | null
  /**
   * Paint a draft palette on the real shell. The organisation Appearance page
   * is the only caller; `null` restores the resolved state. A preview never
   * touches the account's choice or the first-paint cache.
   */
  setPreview: (evaluated: EvaluatedTheme | null) => void
  setTheme: (theme: Theme) => void
  signInTheme: SignInTheme
  theme: Theme
  themes: readonly ThemeOption[]
}

const BUILT_IN_THEMES = [
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

const ThemeContext = createContext<ThemeContextValue | null>(null)

const systemPrefersDark = (mediaQuery?: MediaQueryList): boolean => {
  if (mediaQuery) return mediaQuery.matches
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(SYSTEM_THEME_QUERY).matches
}

/**
 * The one `[data-theme="organization"]` rule, kept in `<head>`.
 *
 * A rule keyed on `data-theme` rather than inline custom properties on the root
 * element: picking a built-in makes this inert, where inline root properties
 * would beat every `[data-theme]` block in the stylesheet until removed by hand.
 */
const writeOrganizationStyle = (css: string | null): void => {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(ORGANIZATION_THEME_STYLE_ID)
  if (css === null) {
    existing?.remove()
    return
  }
  const style = existing ?? document.createElement('style')
  style.id = ORGANIZATION_THEME_STYLE_ID
  style.textContent = css
  if (!existing) document.head.appendChild(style)
}

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const { me, sessionState } = useAuthSession()
  const { mutate: updatePreferences } = useUpdatePreferences()
  const { data: organization } = useCurrentOrganization()
  const serverChoice = me?.user.preferences?.theme
  const [localChoice, setLocalChoice] = useState<Theme | null>(() => readThemeChoice())
  const [preview, setPreview] = useState<EvaluatedTheme | null>(null)
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark())

  useEffect(() => {
    forgetLegacyTheme()
  }, [])

  // The organisation's saved palette. `undefined` (still loading) is a
  // different answer from `null` (there is none): treating the first as the
  // second would repaint Sandstone for one round-trip on every warm load.
  const savedTheme = organization?.theme ?? null
  const savedEvaluated = useMemo(
    () => (savedTheme ? evaluateOrganizationTheme(savedTheme) : null),
    [savedTheme],
  )
  const signedIn = sessionState === 'authenticated'
  // Hold the first-paint palette only while a palette may still arrive. Signed
  // out there is none to wait for — the sign-in screen is instance state, not
  // tenant state (§4.3) — so the block is cleared rather than held.
  const awaitingOrganization = sessionState === 'loading'
    || (signedIn && organization === undefined)
  const organizationHasTheme = preview !== null || savedEvaluated !== null

  const { applied, choice } = resolveThemeChoice({
    localChoice,
    organizationHasTheme,
    serverChoice,
    signedIn,
    systemDark,
  })

  const effective = preview ?? savedEvaluated

  useEffect(() => {
    if (typeof document === 'undefined') return

    if (awaitingOrganization && preview === null) return

    writeOrganizationStyle(effective ? organizationThemeCss(effective) : null)
    // The cache is the SAVED palette, never the draft: a preview is this
    // screen's, and a reload must come back to what the organisation actually
    // has. Written independently of the preview so that saving and reloading
    // without leaving the page still paints from cache.
    writeOrganizationThemeCss(savedEvaluated ? organizationThemeCss(savedEvaluated) : null)

    document.documentElement.dataset.theme = applied
    writeAppliedTheme(applied)
  }, [applied, awaitingOrganization, effective, preview, savedEvaluated])

  useEffect(() => {
    if (choice !== 'system' || typeof window === 'undefined') return undefined
    if (typeof window.matchMedia !== 'function') return undefined

    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY)
    const sync = (): void => setSystemDark(mediaQuery.matches)
    sync()
    mediaQuery.addEventListener('change', sync)
    return () => mediaQuery.removeEventListener('change', sync)
  }, [choice])

  // Carry a pre-login pick onto the account the first time this person signs in
  // without one. Only `nessie.theme.choice` is read, and only the picker writes
  // it, so a default is never mirrored as a choice.
  const transferredTheme = useRef(false)
  useEffect(() => {
    if (!me || transferredTheme.current || serverChoice !== undefined) return
    const stored = readThemeChoice()
    if (stored) {
      transferredTheme.current = true
      updatePreferences({ theme: stored })
    }
  }, [me, serverChoice, updatePreferences])

  const setTheme = useCallback((nextTheme: Theme) => {
    setLocalChoice(nextTheme)
    writeThemeChoice(nextTheme)
    if (me) updatePreferences({ theme: nextTheme })
  }, [me, updatePreferences])

  const value = useMemo<ThemeContextValue>(
    () => ({
      organizationTheme: effective,
      setPreview,
      setTheme,
      // An organisation palette has no counterpart on UOA's page, so hand it
      // the built-in of the same appearance — the pair `system` already uses.
      signInTheme: applied === 'organization'
        ? (effective?.colorScheme === 'light' ? 'daylight' : 'nebula')
        : applied,
      theme: choice,
      themes: savedEvaluated
        ? [
          {
            description: "Your organisation's colours.",
            id: 'organization' as const,
            label: organization?.name ?? 'Organisation',
          },
          ...BUILT_IN_THEMES,
        ]
        : BUILT_IN_THEMES,
    }),
    [applied, choice, effective, organization?.name, savedEvaluated, setTheme],
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

export { DEFAULT_THEME }
