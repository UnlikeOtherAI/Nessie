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
 * A type-to-filter model picker. The catalogue arrives already ordered
 * (provider, then newest version first), so grouping only has to walk it and
 * start a new section whenever the provider changes.
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
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => filterModelOptions(options, query), [options, query])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const openList = () => {
    if (disabled) return
    setQuery('')
    setActiveIndex(Math.max(0, filtered.findIndex((option) => option === value)))
    setOpen(true)
  }

  const pick = (option: AgentModelOption) => {
    onSelect(option)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!open) return
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
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
          setQuery(event.target.value)
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
        value={open ? query : value ? modelOptionLabel(value) : ''}
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
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
        role="listbox"
      >
        <div ref={listRef}>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[color:var(--tx3)]">{emptyLabel}</div>
          ) : null}
          {onLinkSubscription
            && !filtered.some((option) => modelOptionSource(option) === 'subscription')
            ? (
              // The doorway: the question "can this agent run on my own plan?"
              // arises here, so the way to link one lives here too.
              <div
                className={[
                  'mt-1 cursor-pointer border-t border-[color:var(--sep)]',
                  'px-3 py-2 text-xs text-[color:var(--tx2)]',
                ].join(' ')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setOpen(false)
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
            const startsProvider = filtered[index - 1]?.providerDisplayName
              !== option.providerDisplayName
            // One "Your subscriptions" heading marks where the person's own
            // plans begin; the provider groups inside it stay as they are.
            const previous = filtered[index - 1]
            const startsSubscriptions =
              modelOptionSource(option) === 'subscription'
              && (previous === undefined || modelOptionSource(previous) !== 'subscription')
            return (
              <div key={modelOptionKey(option)}>
                {startsSubscriptions ? (
                  <div
                    className={[
                      'mt-1 border-t border-[color:var(--sep)] px-3 pb-1 pt-2',
                      'text-[10px] font-semibold uppercase tracking-[0.16em]',
                      'text-[color:var(--tx2)]',
                    ].join(' ')}
                  >
                    Your subscriptions
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
