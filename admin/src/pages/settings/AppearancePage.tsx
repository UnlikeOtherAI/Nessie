import { useTheme } from '../../providers/ThemeProvider'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

export const AppearancePage = () => {
  const { setTheme, theme, themes } = useTheme()

  return (
    <SettingsPanel eyebrow="General" title="Appearance">
      <section className="admin-card max-w-3xl p-4">
        <div className={sectionTitleClass}>Theme</div>
        <div className="mt-2 text-sm text-[color:var(--tx2)]">
          Choose the admin color palette for this browser.
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
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
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
                  <span
                    className={[
                      'h-3 w-3 rounded-full border',
                      selected
                        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]'
                        : 'border-[color:var(--tx3)]',
                    ].join(' ')}
                  />
                </div>
                <div className="mt-1 text-sm text-[color:var(--tx2)]">
                  {themeOption.description}
                </div>
              </label>
            )
          })}
        </fieldset>
      </section>
    </SettingsPanel>
  )
}
