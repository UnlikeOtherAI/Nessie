import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { faChevronDown, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../overlays/Popover'

export type PersonOption = { id: string; name: string; subtitle?: string }

type PersonPickerProps = {
  disabled?: boolean
  // Rendered when the search matches nobody.
  emptyLabel?: string
  id?: string
  // The accessible name of the list, e.g. "People to share with".
  label?: string
  // Chosen once, then the picker clears itself: it is an "add" control, not a
  // bound field. The caller writes immediately and the list below it is the
  // record of what happened.
  onSelect: (person: PersonOption) => void
  // Already excludes the viewer and everyone who has access — the caller owns
  // that, because it is the caller that knows what "already" means.
  options: PersonOption[]
  placeholder?: string
}

/**
 * Pick a person. `AssigneePicker`'s list and keyboard, with agents removed and
 * no bound value.
 *
 * It is a separate component rather than a mode of the assignee picker because
 * the two answer different questions: an assignee is a person *or an agent*
 * and the answer is stored on a field, while sharing is offered to people only
 * — an agent reaches a document through its own access, never through a share
 * — and every pick is a write that has already happened by the time the list
 * below re-renders.
 */
export const PersonPicker = ({
  disabled = false,
  emptyLabel = 'No matches',
  id,
  label = 'People',
  onSelect,
  options,
  placeholder = 'Add a person…',
}: PersonPickerProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return options
    return options.filter((option) => option.name.toLowerCase().includes(term))
  }, [options, query])

  useEffect(() => {
    if (!open) return undefined
    setQuery('')
    setHighlight(0)
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focus)
  }, [open])

  const pick = (option: PersonOption) => {
    setOpen(false)
    onSelect(option)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((index) => Math.min(index + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = filtered[highlight]
      if (option) pick(option)
    }
  }

  return (
    <div className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="admin-input flex items-center justify-between gap-2 text-left"
        disabled={disabled}
        id={id}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span className="truncate text-[color:var(--tx3)]">{placeholder}</span>
        <FontAwesomeIcon className="shrink-0 text-[10px] text-[color:var(--tx3)]" icon={faChevronDown} />
      </button>

      <Popover
        anchorRef={triggerRef}
        className="overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg"
        label={label}
        matchAnchorWidth
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
        role="listbox"
      >
        <div className="border-b border-[color:var(--sep)] p-2">
          <input
            className="admin-input"
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search people…"
            ref={inputRef}
            value={query}
          />
        </div>
        <ul className="max-h-56 overflow-y-auto py-1">
          {filtered.map((option, index) => (
            <li key={option.id}>
              <button
                className={[
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[color:var(--tx2)]',
                  index === highlight ? 'bg-[color:var(--overlay)]' : '',
                ].join(' ')}
                onClick={() => pick(option)}
                onMouseEnter={() => setHighlight(index)}
                type="button"
              >
                <FontAwesomeIcon
                  className="w-3 shrink-0 text-[10px] text-[color:var(--tx3)]"
                  icon={faUser}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{option.name}</span>
                {option.subtitle ? (
                  <span className="shrink-0 text-xs text-[color:var(--tx3)]">{option.subtitle}</span>
                ) : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-[color:var(--tx3)]">{emptyLabel}</li>
          ) : null}
        </ul>
      </Popover>
    </div>
  )
}
