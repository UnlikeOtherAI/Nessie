import { faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

type AppSearchInputProps = {
  onChange: (value: string) => void
  value: string
}

// The catalogue's one search field. Not `.admin-input`: that class claims
// padding, so the leading magnifier would sit on top of the caret and no
// `pl-*` utility could move it (see the unlayered-control note in styles.css).
// The wrapper carries the type scale instead of the input, because the
// `button, input, select, textarea { font: inherit }` reset is unlayered too
// and makes `text-sm` on a control inert.
export const AppSearchInput = ({ onChange, value }: AppSearchInputProps) => (
  <div className="relative flex-1 text-sm">
    <FontAwesomeIcon
      className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--tx3)]"
      icon={faMagnifyingGlass}
    />
    <input
      aria-label="Search apps"
      className={[
        'h-9 w-full rounded-[var(--radius-md)] border border-[color:var(--sep)]',
        'bg-[color:var(--panel)] pl-9 pr-9 text-[color:var(--tx)]',
        'placeholder:text-[color:var(--tx3)] focus:border-[color:var(--accent)]',
        'focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]',
      ].join(' ')}
      data-testid="apps-search-input"
      onChange={(event) => onChange(event.target.value)}
      placeholder="Search apps…"
      type="text"
      value={value}
    />
    {value ? (
      <button
        aria-label="Clear search"
        className={[
          'absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2',
          'items-center justify-center rounded-full text-[color:var(--tx3)]',
          'hover:bg-[color:var(--overlay-weak)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        data-testid="apps-search-clear"
        onClick={() => onChange('')}
        type="button"
      >
        <FontAwesomeIcon className="h-3 w-3" icon={faXmark} />
      </button>
    ) : null}
  </div>
)
