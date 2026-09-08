import { useEffect, useMemo, useRef, useState } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../../../overlays/Popover'
import type { AgentModelOption } from '../../../../lib/api-client'
import {
  filterModelOptions,
  modelOptionKey,
  modelOptionLabel,
  modelOptionSource,
  modelOptionSubtitle,
  orderModelOptionsForPicker,
  readTypedQuery,
} from './model-options'
import { STREAMING_HIGHLIGHT_CLASS } from './streaming-highlight'

type ModelComboboxProps = {
  disabled?: boolean
  emptyLabel: string
  highlighted?: boolean
  id: string
  onSelect: (option: AgentModelOption) => void
  /** Opens the place a person links their own plan. Omit to hide the row. */
  onLinkSubscription?: () => void
  options: AgentModelOption[]
  placeholder: string
  value: AgentModelOption | null
}

/**
 * A type-to-filter model picker. The person's own subscriptions lead the list
 * ({@link orderModelOptionsForPicker}); inside each source the catalogue
 * arrives already ordered (provider, then newest version first), so grouping
 * only has to walk it and start a new section whenever the provider changes.
 */
export const ModelCombobox = ({
  disabled,
  emptyLabel,
  highlighted,
  id,
  onLinkSubscription,
  onSelect,
  options,
  placeholder,
  value,
}: ModelComboboxProps) => {
  const [open, setOpen] = useState(false)
  // `null` means "not typing": the field then shows the selected model rather
  // than an empty box wearing the placeholder, so opening the list never reads
  // as having thrown the person's own choice away.
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const ordered = useMemo(() => orderModelOptionsForPicker(options), [options])
  const filtered = useMemo(
    () => filterModelOptions(ordered, query ?? ''),
    [ordered, query],
  )

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // A search typed over the model name in the field arrives as the whole name
  // plus the keystroke; `readTypedQuery` is what pulls the person's own text
  // back out of it.
  const typedQuery = (next: string): string =>
    query === null ? readTypedQuery(value ? modelOptionLabel(value) : '', next) : next

  const openList = () => {
    if (disabled) return
    setQuery(null)
    // Against the unfiltered list, which is exactly what an untyped open
    // renders: the current model is the row the list opens on, and the effect
    // above scrolls to it.
    setActiveIndex(Math.max(0, ordered.findIndex((option) => option === value)))
    setOpen(true)
  }

  // Every close goes back to showing the selection, so a half-typed search is
  // never left sitting in the field as though it were the chosen model.
  const closeList = () => {
    setQuery(null)
    setOpen(false)
  }

  const pick = (option: AgentModelOption) => {
    onSelect(option)
    closeList()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!open) return
      event.stopPropagation()
      closeList()
      return
    }
    if (event.key === 'Tab') {
      closeList()
      return
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      openList()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = filtered[activeIndex]
      if (option) pick(option)
    }
  }

  return (
    <div className="relative">
      <input
        aria-activedescendant={open && filtered[activeIndex]
          ? `${id}-option-${activeIndex}`
          : undefined}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        autoComplete="off"
        className={[
          'admin-input pr-8',
          highlighted ? STREAMING_HIGHLIGHT_CLASS : '',
        ].join(' ')}
        disabled={disabled}
        id={id}
        onChange={(event) => {
          setQuery(typedQuery(event.target.value))
          setActiveIndex(0)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onMouseDown={() => {
          if (!open) openList()
        }}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        type="text"
        value={query ?? (value ? modelOptionLabel(value) : '')}
      />
      <FontAwesomeIcon
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[color:var(--tx3)]"
        icon={faChevronDown}
      />

      <Popover
        anchorRef={inputRef}
        className={[
          'max-h-72 overflow-y-auto overflow-x-hidden py-1',
          'rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg',
        ].join(' ')}
        id={`${id}-listbox`}
        label={placeholder}
        matchAnchorWidth
        onClose={closeList}
        open={open}
        placement="bottom-start"
        role="listbox"
      >
        {/* The panel's own max-height is an inline style Popover computes from
            the space available, and an inline style beats `max-h-72` on the
            panel — which is how this list grew to the height of the window and
            covered the field it hangs off. Capping the scroller INSIDE the
            panel keeps both: a list that stops at 18rem, and Popover's clamp
            for the times there is less room than that. */}
        <div className="max-h-72 overflow-y-auto overflow-x-hidden" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[color:var(--tx3)]">{emptyLabel}</div>
          ) : null}
          {onLinkSubscription
            && !ordered.some((option) => modelOptionSource(option) === 'subscription')
            ? (
              // The doorway: the question "can this agent run on my own plan?"
              // arises here, so the way to link one lives here too. Read off the
              // whole catalogue rather than the filtered rows — a search that
              // happens to exclude a person's own models is not a person with
              // no plan linked.
              <div
                className={[
                  'mt-1 cursor-pointer border-t border-[color:var(--sep)]',
                  'px-3 py-2 text-xs text-[color:var(--tx2)]',
                ].join(' ')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  closeList()
                  onLinkSubscription()
                }}
                role="option"
                aria-selected={false}
              >
                Link a personal subscription…
              </div>
            )
            : null}
          {filtered.map((option, index) => {
            const isActive = index === activeIndex
            const previous = filtered[index - 1]
            // A section is one spending lane. Its heading also restarts the
            // provider grouping, so two providers that happen to share a
            // display name across the boundary still get one heading each.
            const startsSection = previous === undefined
              || modelOptionSource(previous) !== modelOptionSource(option)
            const startsProvider = previous === undefined
              || startsSection
              || previous.providerDisplayName !== option.providerDisplayName
            const isSubscription = modelOptionSource(option) === 'subscription'
            // "Your subscriptions" leads the list whenever the person has any.
            // The Ledger heading only earns its place underneath one — on its
            // own the catalogue is the whole list and needs no label.
            const sectionLabel = !startsSection
              ? null
              : isSubscription
                ? 'Your subscriptions'
                : previous === undefined ? null : 'Ledger models'
            return (
              <div key={modelOptionKey(option)}>
                {sectionLabel ? (
                  <div
                    className={[
                      'mt-1 border-t border-[color:var(--sep)] px-3 pb-1 pt-2',
                      'text-[10px] font-semibold uppercase tracking-[0.16em]',
                      'text-[color:var(--tx2)]',
                    ].join(' ')}
                  >
                    {sectionLabel}
                  </div>
                ) : null}
                {startsProvider ? (
                  <div
                    className={[
                      'px-3 pb-1 pt-2 text-[10px] font-semibold uppercase',
                      'tracking-[0.16em] text-[color:var(--tx3)]',
                    ].join(' ')}
                  >
                    {option.providerDisplayName}
                  </div>
                ) : null}
                <div
                  aria-selected={option === value}
                  className={[
                    'cursor-pointer px-3 py-1.5',
                    isActive ? 'bg-[color:var(--overlay)]' : '',
                  ].join(' ')}
                  data-active={isActive}
                  id={`${id}-option-${index}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pick(option)
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                >
                  <div
                    className={[
                      'truncate text-sm',
                      option === value ? 'text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
                    ].join(' ')}
                  >
                    {option.displayName}
                  </div>
                  <div className="truncate text-[8px] leading-[12px] text-[color:var(--tx3)]">
                    {modelOptionSubtitle(option)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}
