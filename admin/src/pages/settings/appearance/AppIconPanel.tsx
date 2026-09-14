import { SectionLabel } from '../../../components/primitives/SectionLabel'
import {
  requestNativeAppIcon,
  useNativeAppIcon,
  type AppIconVariant,
} from '../../../facades/native-app-icon'

const OPTIONS: Array<{ id: AppIconVariant; label: string; src: string }> = [
  { id: 'light', label: 'Light', src: '/app-icon-light.png' },
  { id: 'dark', label: 'Dark', src: '/app-icon-dark.png' },
]

/**
 * The Home Screen icon, offered only inside an iOS build that can switch it.
 * The selection follows what the phone reports, not the tap: iOS may refuse.
 */
export const AppIconPanel = () => {
  const { available, icon } = useNativeAppIcon()
  if (!available) return null

  return (
    <section className="admin-card p-4">
      <SectionLabel>App icon</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        Sets the Nessie icon on this phone&apos;s Home Screen.
      </div>

      <fieldset className="mt-4 flex flex-wrap gap-3 border-0 p-0">
        <legend className="sr-only">App icon</legend>
        {OPTIONS.map((option) => {
          const selected = icon === option.id

          return (
            <label
              key={option.id}
              className={[
                'admin-card flex cursor-pointer flex-col items-center gap-2 p-3 transition',
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
                name="appIcon"
                onChange={() => requestNativeAppIcon(option.id)}
                type="radio"
                value={option.id}
              />
              <img
                alt=""
                className="h-16 w-16 rounded-[22%] shadow-[0_0_0_1px_var(--border)]"
                src={option.src}
              />
              <div className="font-semibold text-[color:var(--tx)]">{option.label}</div>
            </label>
          )
        })}
      </fieldset>
    </section>
  )
}
