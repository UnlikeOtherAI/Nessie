import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type {
  PageHeaderAction,
  PageHeaderButtonAction,
  PageHeaderMenuItem,
} from './ResponsivePageHeader'

type PageHeaderMenuProps = {
  action: PageHeaderAction
  onSelect: (item: Exclude<PageHeaderMenuItem, { href: string }> | PageHeaderButtonAction) => void
}

export const PageHeaderMenu = ({ action, onSelect }: PageHeaderMenuProps) => {
  const items = action.kind === 'menu' ? action.items : [action]

  return (
    <>
      {action.kind === 'menu' ? (
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
          {action.label}
        </div>
      ) : null}
      {items.map((item) => {
        const icon = item.icon
        if ('href' in item) {
          return (
            <a
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
              href={item.href}
              key={item.id}
              rel={item.rel}
              role="menuitem"
              target={item.target}
              title={item.title}
            >
              {icon ? <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={icon} /> : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </a>
          )
        }

        const checked = 'checked' in item ? item.checked : undefined
        const role = checked === undefined ? 'menuitem' : 'menuitemradio'
        return (
          <button
            aria-checked={checked}
            className={[
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs',
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
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {checked ? <span aria-hidden="true">✓</span> : null}
          </button>
        )
      })}
    </>
  )
}
