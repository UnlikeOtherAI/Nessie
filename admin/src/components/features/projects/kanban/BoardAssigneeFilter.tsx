import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { faChevronDown, faUser, faUserSlash, faUsers } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { PROVIDER_LABEL } from '../../../../facades/board-sources/hooks'
import type { AssignableUser } from '../../../../facades/tasks/hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { Popover } from '../../../overlays/Popover'
import { IdentityTile } from '../../../primitives/IdentityTile'
import { UserAvatar } from '../../../shared/UserAvatar'
import type { AssigneeFilter, RemoteAssigneeOption } from './board-assignee-filter'

type BoardAssigneeFilterProps = {
  value: AssigneeFilter
  onChange: (next: AssigneeFilter) => void
  people: AssignableUser[]
  remote: RemoteAssigneeOption[]
  /** Absent while the session is still loading; "My issues" waits for it. */
  currentUserId: string | null
}

type StaticChoice = {
  icon: typeof faUser
  label: string
  value: Extract<AssigneeFilter, 'all' | 'me' | 'unassigned'>
}

const allAssigneesChoice: StaticChoice = { icon: faUsers, label: 'All assignees', value: 'all' }
const unassignedChoice: StaticChoice = { icon: faUser, label: 'Unassigned', value: 'unassigned' }
const initialChoices: StaticChoice[] = [allAssigneesChoice, unassignedChoice]

const RemoteAssigneeAvatar = ({ label, size }: { label: string; size: number }) => (
  <IdentityTile
    background="var(--panel-soft)"
    color="var(--tx2)"
    fallback={{ kind: 'icon', icon: <FontAwesomeIcon icon={faUserSlash} /> }}
    imageUrl={null}
    label={`${label} — not mapped`}
    size={size}
  />
)

const optionClassName = (highlighted: boolean, selected: boolean): string => [
  'flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
  highlighted ? 'bg-[color:var(--overlay)]' : 'hover:bg-[color:var(--main-hover)]',
  selected ? 'text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
].join(' ')

/**
 * Narrow the board to one person's cards without flattening provider people
 * into the project roster. The listbox uses the shared popover so it follows
 * the anchor on scroll, flips at the viewport edge, and closes through the
 * navigation overlay lifecycle.
 */
export const BoardAssigneeFilter = ({
  value,
  onChange,
  people,
  remote,
  currentUserId,
}: BoardAssigneeFilterProps) => {
  const { token } = useAuthSession()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const listboxId = useId()

  const staticChoices = useMemo<StaticChoice[]>(
    () => currentUserId
      ? [
          allAssigneesChoice,
          { icon: faUser, label: 'My issues', value: 'me' },
          unassignedChoice,
        ]
      : initialChoices,
    [currentUserId],
  )
  const term = query.trim().toLocaleLowerCase()
  const matchingStatic = useMemo(
    () => term ? staticChoices.filter((choice) => choice.label.toLocaleLowerCase().includes(term)) : staticChoices,
    [staticChoices, term],
  )
  const matchingPeople = useMemo(
    () => term ? people.filter((person) => person.displayName.toLocaleLowerCase().includes(term)) : people,
    [people, term],
  )
  const matchingRemote = useMemo(
    () => term ? remote.filter((person) => person.label.toLocaleLowerCase().includes(term)) : remote,
    [remote, term],
  )
  const optionValues = useMemo(
    () => [
      ...matchingStatic.map((choice) => choice.value),
      ...matchingPeople.map((person) => `user:${person.id}`),
      ...matchingRemote.map((person) => person.value),
    ],
    [matchingPeople, matchingRemote, matchingStatic],
  )
  const selectedPerson = people.find((person) => value === `user:${person.id}`)
  const selectedRemote = remote.find((person) => value === person.value)
  const selectedStatic = staticChoices.find((choice) => value === choice.value)

  useEffect(() => {
    if (!open) return undefined
    setQuery('')
    setHighlighted(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
  }

  const choose = (next: AssigneeFilter) => {
    onChange(next)
    close(true)
  }

  const focusOption = (index: number) => {
    const next = optionValues[index]
    if (!next) return
    setHighlighted(index)
    optionRefs.current.get(next)?.focus()
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
      return
    }

    if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault()
      const next = optionValues[highlighted]
      if (next) choose(next as AssigneeFilter)
      return
    }

    if (event.target === inputRef.current && ['Home', 'End'].includes(event.key)) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLButtonElement>('[data-board-assignee-option]')
      : null
    const currentIndex = target ? optionValues.indexOf(target.value) : highlighted
    if (event.key === 'Home') {
      focusOption(0)
    } else if (event.key === 'End') {
      focusOption(optionValues.length - 1)
    } else if (event.key === 'ArrowDown') {
      focusOption(Math.min(currentIndex + 1, optionValues.length - 1))
    } else {
      focusOption(Math.max(currentIndex - 1, 0))
    }
  }

  const selectedContent = selectedPerson ? (
    <>
      <UserAvatar displayName={selectedPerson.displayName} size={24} token={token} userId={selectedPerson.id} />
      <span className="truncate">{selectedPerson.displayName}</span>
    </>
  ) : selectedRemote ? (
    <>
      <RemoteAssigneeAvatar label={selectedRemote.label} size={24} />
      <span className="min-w-0 flex-1 truncate" title={selectedRemote.label}>
        {selectedRemote.label}
      </span>
    </>
  ) : (
    <>
      <FontAwesomeIcon className="w-4 shrink-0 text-[color:var(--tx3)]" icon={selectedStatic?.icon ?? faUsers} />
      <span className="truncate">{selectedStatic?.label ?? 'All assignees'}</span>
    </>
  )

  const selectedTextId = `${listboxId}-selected`

  return (
    <div className="w-fit max-w-[min(20rem,100%)]" data-board-assignee-filter>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-describedby={selectedTextId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Filter board by assignee"
        className="admin-input flex min-h-11 w-full items-center gap-2 text-left"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2" id={selectedTextId}>
          {selectedContent}
        </span>
        <FontAwesomeIcon className="shrink-0 text-[10px] text-[color:var(--tx3)]" icon={faChevronDown} />
      </button>

      <Popover
        anchorRef={triggerRef}
        className="flex w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg"
        label="Filter board by assignee"
        onClose={() => close()}
        onKeyDown={onListKeyDown}
        open={open}
        placement="bottom-start"
        role="dialog"
      >
        <div className="shrink-0 border-b border-[color:var(--sep)] p-2">
          <input
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label="Search assignees"
            className="admin-input min-h-11"
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlighted(0)
            }}
            placeholder="Search assignees…"
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </div>
        <div aria-label="Filter board by assignee" className="min-h-0 overflow-y-auto py-1" id={listboxId} role="listbox">
          {matchingStatic.map((choice, index) => (
            <button
              aria-selected={value === choice.value}
              className={optionClassName(highlighted === index, value === choice.value)}
              data-board-assignee-option
              key={choice.value}
              onClick={() => choose(choice.value)}
              onMouseEnter={() => setHighlighted(index)}
              ref={(node) => {
                if (node) optionRefs.current.set(choice.value, node)
                else optionRefs.current.delete(choice.value)
              }}
              role="option"
              type="button"
              value={choice.value}
            >
              <FontAwesomeIcon className="w-4 shrink-0 text-[color:var(--tx3)]" icon={choice.icon} />
              <span className="truncate">{choice.label}</span>
            </button>
          ))}

          {matchingPeople.length > 0 ? (
            <div aria-label="People" className="border-t border-[color:var(--sep)] pt-1" role="group">
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
                People
              </div>
              {matchingPeople.map((person) => {
                const optionValue = `user:${person.id}` as AssigneeFilter
                const index = optionValues.indexOf(optionValue)
                return (
                  <button
                    aria-selected={value === optionValue}
                    className={optionClassName(highlighted === index, value === optionValue)}
                    data-board-assignee-option
                    key={person.id}
                    onClick={() => choose(optionValue)}
                    onMouseEnter={() => setHighlighted(index)}
                    ref={(node) => {
                      if (node) optionRefs.current.set(optionValue, node)
                      else optionRefs.current.delete(optionValue)
                    }}
                    role="option"
                    type="button"
                    value={optionValue}
                  >
                    <UserAvatar displayName={person.displayName} size={28} token={token} userId={person.id} />
                    <span className="truncate">{person.displayName}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {matchingRemote.length > 0 ? (
            <div aria-label="Not mapped" className="border-t border-[color:var(--sep)] pt-1" role="group">
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
                Not mapped
              </div>
              {matchingRemote.map((person) => {
                const index = optionValues.indexOf(person.value)
                return (
                  <button
                    aria-selected={value === person.value}
                    className={optionClassName(highlighted === index, value === person.value)}
                    data-board-assignee-option
                    key={person.value}
                    onClick={() => choose(person.value)}
                    onMouseEnter={() => setHighlighted(index)}
                    ref={(node) => {
                      if (node) optionRefs.current.set(person.value, node)
                      else optionRefs.current.delete(person.value)
                    }}
                    role="option"
                    type="button"
                    value={person.value}
                  >
                    <RemoteAssigneeAvatar label={person.label} size={28} />
                    <span className="min-w-0 flex-1 truncate">{person.label}</span>
                    <span className="shrink-0 text-xs text-[color:var(--tx3)]">
                      Not mapped · {PROVIDER_LABEL[person.provider]}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {term && matchingPeople.length === 0 && matchingRemote.length === 0 ? (
            <p className="px-3 py-3 text-sm text-[color:var(--tx3)]">No matching people.</p>
          ) : null}
        </div>
      </Popover>
    </div>
  )
}
