import { useEffect, useMemo, useRef, useState } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentModelOption } from '../../../../lib/api-client'
import {
  filterModelOptions,
  modelOptionKey,
  modelOptionLabel,
  modelOptionSubtitle,
} from './model-options'
import { STREAMING_HIGHLIGHT_CLASS } from './streaming-highlight'

type ModelComboboxProps = {
  disabled?: boolean
  emptyLabel: string
  highlighted?: boolean
  id: string
  onSelect: (option: AgentModelOption) => void
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
  onSelect,
  options,
  placeholder,
  value,
}: ModelComboboxProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => filterModelOptions(options, query), [options, query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

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
    <div className="relative" ref={rootRef}>
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
        role="combobox"
        type="text"
        value={open ? query : value ? modelOptionLabel(value) : ''}
      />
      <FontAwesomeIcon
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[color:var(--tx3)]"
        icon={faChevronDown}
      />

      {open ? (
        <ul
          className={[
            'absolute z-50 mt-1 max-h-72 w-full overflow-y-auto overflow-x-hidden py-1',
            'rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg',
          ].join(' ')}
          id={`${id}-listbox`}
          ref={listRef}
          role="listbox"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-[color:var(--tx3)]">{emptyLabel}</li>
          ) : null}
          {filtered.map((option, index) => {
            const isActive = index === activeIndex
            const startsProvider = filtered[index - 1]?.providerDisplayName
              !== option.providerDisplayName
            return (
              <li key={modelOptionKey(option)}>
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
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
