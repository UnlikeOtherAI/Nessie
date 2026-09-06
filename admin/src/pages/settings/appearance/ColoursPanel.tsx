import { Link } from 'react-router-dom'
import { useCurrentOrganization } from '../../../facades/organization/hooks'
import { useTheme } from '../../../providers/ThemeProvider'
import { DEFAULT_THEME } from '../../../providers/theme-resolution'
import type { Theme } from '../../../lib/theme-storage'
import { Pill } from '../../../components/primitives/Pill'
import { SectionLabel } from '../../../components/primitives/SectionLabel'

const THEME_SWATCHES: Record<Exclude<Theme, 'organization'>, readonly [string, string, string]> = {
  contrast: ['#000000', '#facc15', '#ffffff'],
  daylight: ['#eef2f7', '#2563eb', '#111827'],
  forest: ['#0a160f', '#047857', '#e5eee8'],
  graphite: ['#101113', '#64748b', '#e5e7eb'],
  midnight: ['#0f172a', '#2563eb', '#e5e7eb'],
  nebula: ['#2e1132', '#7c3aed', '#d1d2d3'],
  ocean: ['#07151c', '#0e7490', '#e4eef3'],
  rose: ['#150b11', '#e11d48', '#f2e4ea'],
  sandstone: ['#f1e9dc', '#b45309', '#2b2018'],
  sunset: ['#160d0a', '#c2410c', '#f2e7df'],
  system: ['#eef2f7', '#7c3aed', '#111827'],
}

/**
 * The swatch takes colours rather than a theme id: the built-ins have a static
 * map, and the organisation's card is drawn from its own derived tokens.
 */
const ThemeSwatch = ({ colours }: { colours: readonly [string, string, string] }) => (
  <div aria-hidden="true" className="flex items-center gap-1">
    {colours.map((color, index) => (
      <span
        key={`${color}-${index}`}
        className="h-3 w-3 rounded-full border border-[color:var(--sep)]"
        style={{ backgroundColor: color }}
      />
    ))}
  </div>
)

/**
 * Where a person picks their colours — including, at the top of the grid, the
 * organisation's own (docs/plans/2026-09-05-organisation-custom-theme.md §7.6).
 *
 * This panel is the doorway, never the home: it shows and picks the
 * organisation theme, and an administrator authors it on
 * `/settings/organization?tab=appearance`.
 */
export const ColoursPanel = () => {
  const { organizationTheme, setTheme, theme, themes } = useTheme()
  const { data: organization } = useCurrentOrganization()

  const hasOrganizationTheme = themes.some((option) => option.id === 'organization')
  // The card carrying the default for anyone who has not chosen: the
  // organisation's palette when there is one, Sandstone otherwise.
  const defaultTheme: Theme = hasOrganizationTheme ? 'organization' : DEFAULT_THEME
  // A choice of `organization` in an organisation with no palette renders
  // Sandstone, so mark Sandstone rather than leaving no card selected.
  const selectedTheme: Theme =
    theme === 'organization' && !hasOrganizationTheme ? DEFAULT_THEME : theme
  const canAdminister = organization?.administration.status === 'allowed'

  return (
    <section className="admin-card p-4">
      <SectionLabel>Theme</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        Choose the admin color palette for your account.
      </div>

      <fieldset className="mt-4 grid gap-3 border-0 p-0 md:grid-cols-3">
        <legend className="sr-only">Admin theme</legend>
        {themes.map((themeOption) => {
          const selected = selectedTheme === themeOption.id
          const swatch = themeOption.id === 'organization'
            ? ([
              organizationTheme?.tokens.rail ?? '#000000',
              organizationTheme?.tokens.accent ?? '#000000',
              organizationTheme?.tokens.tx ?? '#ffffff',
            ] as const)
            : THEME_SWATCHES[themeOption.id]

          return (
            <label
              key={themeOption.id}
              className={[
                'admin-card cursor-pointer p-3 transition',
                'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2',
                'focus-within:outline-[color:var(--accent)]',
                selected
                  ? 'bg-[color:var(--accent-soft)] ring-2 ring-[color:var(--accent)]'
                  : 'hover:bg-[color:var(--main-hover)]',
              ].join(' ')}
            >
              <input
                checked={selected}
                className="sr-only"
                name="theme"
                onChange={() => setTheme(themeOption.id)}
                type="radio"
                value={themeOption.id}
              />
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate font-semibold text-[color:var(--tx)]">
                  {themeOption.label}
                </div>
                <ThemeSwatch colours={swatch} />
              </div>
              <div className="mt-1 flex items-start justify-between gap-2">
                <div className="text-sm text-[color:var(--tx2)]">{themeOption.description}</div>
                {defaultTheme === themeOption.id ? <Pill tone="muted">Default</Pill> : null}
              </div>
            </label>
          )
        })}
      </fieldset>

      {canAdminister ? (
        <Link
          className="mt-4 inline-block text-sm text-[color:var(--lnk)] hover:underline"
          to="/settings/organization?tab=appearance"
        >
          {hasOrganizationTheme
            ? "Edit your organisation's theme →"
            : "Set up a theme in your organisation's colours →"}
        </Link>
      ) : null}
    </section>
  )
}
