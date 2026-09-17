import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type {
  PageHeaderAction,
  PageHeaderButtonAction,
  PageHeaderMenuButtonItem,
  PageHeaderToggleAction,
} from './ResponsivePageHeader'

type PageHeaderMenuProps = {
  action: PageHeaderAction
  onSelect: (
    item:
      | PageHeaderMenuButtonItem
      | PageHeaderButtonAction
      | PageHeaderToggleAction,
  ) => void
}

// A row's label with its optional detail underneath. One press target: the
// detail is read, never pressed, so it inherits the row's control rather than
// becoming one of its own.
const menuRowText = (item: { detail?: string; label: string }) => (
  <span className="min-w-0 flex-1">
    <span className="block truncate">{item.label}</span>
    {item.detail ? (
      <span className="block text-[10px] leading-snug text-[color:var(--tx3)]">
        {item.detail}
      </span>
    ) : null}
  </span>
)

export const PageHeaderMenu = ({ action, onSelect }: PageHeaderMenuProps) => {
  // A `custom` action is pinned, so More never receives one — and if it ever
  // did, it has no rows to draw.
  const items = action.kind === 'custom'
    ? []
    : action.kind === 'menu' ? action.items : [action]

  return (
    <>
      {action.kind === 'menu' ? (
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
          {action.label}
        </div>
      ) : null}
      {items.map((item) => {
        if ('kind' in item && item.kind === 'separator') {
          return (
            <div
              aria-hidden="true"
              className="my-1 border-t border-[color:var(--sep)]"
              key={item.id}
              role="separator"
            />
          )
        }
        if ('kind' in item && item.kind === 'note') {
          // A footnote, never a choice: it answers a question and offers no
          // press, so it takes neither a menu role nor the focus the
          // keyboard walk stops on.
          return (
            <div
              className="px-2.5 py-1 text-[11px] leading-snug text-[color:var(--tx3)]"
              key={item.id}
            >
              {item.label}
            </div>
          )
        }
        const icon = item.icon
        if ('href' in item) {
          return (
            <a
              className="admin-page-menu-row flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
              href={item.href}
              key={item.id}
              rel={item.rel}
              role="menuitem"
              target={item.target}
              title={item.title}
            >
              {icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={icon} /> : null}
              {menuRowText(item)}
            </a>
          )
        }

        // A toggle that overflowed keeps its meaning here: it is still one
        // state you turn on and off, so it is a checkbox item rather than the
        // radio choice a menu action's `checked` marks. A row can say the same
        // of itself with `checkbox`, for a menu that carries both — a view to
        // choose between, and an independent "Show archived".
        const toggle = 'kind' in item && item.kind === 'toggle'
        const standalone = toggle || ('checkbox' in item && item.checkbox === true)
        const checked = 'checked' in item ? item.checked : undefined
        const role = checked === undefined
          ? 'menuitem'
          : standalone ? 'menuitemcheckbox' : 'menuitemradio'
        return (
          <button
            aria-checked={checked}
            className={[
              // The size lives on `.admin-page-menu-row` in styles.css, not a
              // `text-*` utility: the unlayered `button { font: inherit }` reset
              // beats Tailwind's layered utilities on a button.
              'admin-page-menu-row flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left',
              'text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
              checked ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]' : '',
              item.disabled ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
            disabled={item.disabled}
            key={item.id}
            onClick={() => onSelect(item)}
            role={role}
            title={item.title}
            type="button"
          >
            {icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={icon} /> : null}
            {menuRowText(item)}
            {checked ? <span aria-hidden="true">✓</span> : null}
          </button>
        )
      })}
    </>
  )
}
