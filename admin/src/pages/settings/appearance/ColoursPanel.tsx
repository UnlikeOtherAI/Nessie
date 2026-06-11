import { useTheme, type Theme } from '../../../providers/ThemeProvider'
import { sectionTitleClass } from '../settings-shared'

const THEME_SWATCHES: Record<Theme, readonly [string, string, string]> = {
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

const ThemeSwatch = ({ themeId }: { themeId: Theme }) => (
  <div aria-hidden="true" className="flex items-center gap-1">
    {THEME_SWATCHES[themeId].map((color, index) => (
      <span
        key={`${themeId}-${color}-${index}`}
        className="h-3 w-3 rounded-full border border-[color:var(--sep)]"
        style={{ backgroundColor: color }}
      />
    ))}
  </div>
)

export const ColoursPanel = () => {
  const { setTheme, theme, themes } = useTheme()

  return (
    <section className="admin-card max-w-3xl p-4">
      <div className={sectionTitleClass}>Theme</div>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        Choose the admin color palette for your account.
      </div>

      <fieldset className="mt-4 grid gap-3 border-0 p-0 md:grid-cols-3">
        <legend className="sr-only">Admin theme</legend>
        {themes.map((themeOption) => {
          const selected = theme === themeOption.id

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
                <div className="font-semibold text-[color:var(--tx)]">
                  {themeOption.label}
                </div>
                <ThemeSwatch themeId={themeOption.id} />
              </div>
              <div className="mt-1 text-sm text-[color:var(--tx2)]">
                {themeOption.description}
              </div>
            </label>
          )
        })}
      </fieldset>
    </section>
  )
}
