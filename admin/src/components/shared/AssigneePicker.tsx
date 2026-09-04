import { useEffect, useMemo, useRef, useState } from 'react'
import { faChevronDown, faRobot, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentVisibility } from '@nessie/schemas'
import { Popover } from '../overlays/Popover'
import { AgentVisibilityPill } from '../features/agents/AgentVisibilityPill'

export type AssigneeKind = 'user' | 'agent'
export type AssigneeOption = {
  agentVisibility?: AgentVisibility
  id: string
  name: string
  kind: AssigneeKind
}
export type AssigneeValue = { id: string; kind: AssigneeKind } | null

type AssigneePickerProps = {
  options: AssigneeOption[]
  value: AssigneeValue
  onChange: (value: AssigneeValue) => void
  id?: string
  placeholder?: string
}

const sameValue = (a: AssigneeValue, b: AssigneeOption) => a?.id === b.id && a?.kind === b.kind

// A searchable assignee combobox: type to filter people and agents, arrow keys
// to move, Enter to pick, Escape to close. Selecting "Unassigned" clears it.
export const AssigneePicker = ({ options, value, onChange, id, placeholder }: AssigneePickerProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = value ? options.find((option) => sameValue(value, option)) ?? null : null

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    const matches = term ? options.filter((o) => o.name.toLowerCase().includes(term)) : options
    // The clear option (id '') always leads the list.
    return [{ id: '', name: 'Unassigned', kind: 'user' as AssigneeKind }, ...matches]
  }, [options, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focus)
  }, [open])

  const pick = (option: AssigneeOption) => {
    onChange(option.id ? { id: option.id, kind: option.kind } : null)
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
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
        id={id}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className={selected ? 'truncate text-[color:var(--tx)]' : 'truncate text-[color:var(--tx3)]'}>
            {selected ? selected.name : placeholder ?? 'Unassigned'}
          </span>
          {selected?.kind === 'agent' && selected.agentVisibility ? (
            <AgentVisibilityPill visibility={selected.agentVisibility} />
          ) : null}
        </span>
        <FontAwesomeIcon className="shrink-0 text-[10px] text-[color:var(--tx3)]" icon={faChevronDown} />
      </button>

      <Popover
        anchorRef={triggerRef}
        className="overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg"
        label={placeholder ?? 'Assignee'}
        matchAnchorWidth
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
        role="listbox"
      >
        <div className="border-b border-[color:var(--sep)] p-2">
          <input
            ref={inputRef}
            className="admin-input"
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search people or agents…"
            value={query}
          />
        </div>
        <ul className="max-h-56 overflow-y-auto py-1">
          {filtered.map((option, index) => {
            const isSelected = option.id
              ? sameValue(value, option)
              : value === null
            return (
              <li key={`${option.kind}:${option.id || 'none'}`}>
                <button
                  className={[
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                    index === highlight ? 'bg-[color:var(--overlay)]' : '',
                    isSelected ? 'text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
                  ].join(' ')}
                  onClick={() => pick(option)}
                  onMouseEnter={() => setHighlight(index)}
                  type="button"
                >
                  {option.id ? (
                    <FontAwesomeIcon
                      className="w-3 shrink-0 text-[10px] text-[color:var(--tx3)]"
                      icon={option.kind === 'agent' ? faRobot : faUser}
                    />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className="truncate">{option.name}</span>
                  {option.kind === 'agent' && option.agentVisibility ? (
                    <span className="ml-auto flex-shrink-0">
                      <AgentVisibilityPill visibility={option.agentVisibility} />
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
          {filtered.length === 1 ? (
            <li className="px-3 py-1.5 text-xs text-[color:var(--tx3)]">No matches</li>
          ) : null}
        </ul>
      </Popover>
    </div>
  )
}
